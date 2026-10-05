/**
 * Watches a task the server is running. The browser does not drive the
 * agents: it polls the cheap live endpoint (fast while a step runs or is due,
 * slow while the task waits on a person, not at all while the tab is hidden),
 * shows the running step as it streams, refetches the task when it changes,
 * and hands the live bubble over to the saved message. If a step is due and
 * nothing has picked it up for a few seconds, it nudges the server once, with
 * backoff. TaskView renders what this returns and holds no flow logic.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AGENTS, type AgentId, type Attachment, type LiveState, type Me, type Phase, type Priority, type Task } from '../../agency/types';
import { nextAgent } from '../../agency/flow';
import { ApiFailure, api } from '../api';
import { createLiveStore, type ToolLine } from './live';

export type LoadState = 'loading' | 'ready' | 'notFound' | 'error';
/** running: a step is running on the server · failed: the last step failed and waits for a retry · idle: anything else. */
export type RunStatus = 'idle' | 'running' | 'failed';

/** Poll intervals: while the team is (or should be) working, and while it waits on a person. */
const FAST_MS = 700;
const SLOW_MS = 5000;
/** A due step nobody has started for this long gets a nudge; later nudges back off to the cap. */
const NUDGE_AFTER_MS = 3000;
const NUDGE_MAX_MS = 60_000;
/** Polls that may fail in a row before the view says it has lost the connection. */
const QUIET_FAILURES = 2;

export const PHASE_VERB: Record<Phase, string> = {
  discovery: 'working on the brief',
  feasibility: 'checking feasibility',
  design: 'designing the experience',
  build: 'writing the theme code',
  review: 'reviewing the build',
  gate: 'replying',
  ship: 'shipping the build',
  done: 'replying',
};

export const session = {
  get(key: string): string | null {
    try { return window.sessionStorage.getItem(key); } catch { return null; }
  },
  set(key: string, value: string | null) {
    try {
      if (value === null) window.sessionStorage.removeItem(key);
      else window.sessionStorage.setItem(key, value);
    } catch { /* storage unavailable: keep it in memory only */ }
  },
};

const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Something went wrong.');

/** Who acts next once the task is not paused: who a paused task is waiting to start. */
export const upNext = (task: Task): AgentId | null => nextAgent({ ...task, paused: false });

export function useTaskRunner(taskId: string, me: Me, onTaskChanged: (task: Task) => void) {
  const [task, setTask] = useState<Task | null>(null);
  const [load, setLoad] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState('');
  const [running, setRunning] = useState(false);
  /** The poll keeps failing: the view may be out of date. */
  const [offline, setOffline] = useState(false);
  /** Ids of messages that replaced the live bubble: they appear without an entrance animation. */
  const [streamed, setStreamed] = useState<ReadonlySet<string>>(() => new Set());
  /** Tool lines per message, for steps watched in this session. */
  const [activity, setActivity] = useState<Readonly<Record<string, ToolLine[]>>>({});
  const [announcement, setAnnouncement] = useState('');

  const live = useMemo(createLiveStore, []);
  const taskRef = useRef(task);
  taskRef.current = task;
  const runningRef = useRef(false);
  const changedRef = useRef(onTaskChanged);
  changedRef.current = onTaskChanged;
  /** Wakes the poll loop now (after an action, on focus). Set by the loop. */
  const pollNowRef = useRef<() => void>(() => {});
  const llmReady = me.llmReady;

  const announce = useCallback((text: string) => {
    // Re-set even an identical string so screen readers repeat it.
    setAnnouncement('');
    window.setTimeout(() => setAnnouncement(text), 30);
  }, []);

  /**
   * Take a newer copy of the task. Messages the live step produced replace its
   * bubble in the same render, keeping its tool lines; older copies (an action's
   * response racing a poll) are ignored.
   */
  const reconcile = useCallback((next: Task, stepOver: boolean) => {
    const prev = taskRef.current;
    if (prev && prev.id === next.id && next.updatedAt < prev.updatedAt) return;
    const known = new Set(prev?.messages.map((m) => m.id));
    const added = next.messages.filter((m) => !known.has(m.id));
    const view = live.get();

    if (view.agent && added.length) {
      const fromStep = added.filter((m) => m.from === view.agent);
      if (fromStep.length) {
        live.flush();
        setStreamed((s) => { const n = new Set(s); fromStep.forEach((m) => n.add(m.id)); return n; });
        const tools = live.tools();
        if (tools.length) setActivity((a) => ({ ...a, [fromStep[0]!.id]: tools }));
      }
    }
    if (stepOver || added.some((m) => m.kind === 'error')) live.end();

    taskRef.current = next;
    setTask(next);
    changedRef.current(next);

    if (!prev || prev.id !== next.id) return;
    const failed = added.find((m) => m.kind === 'error');
    if (failed) announce(`A step failed: ${failed.text}`);
    else if (next.waiting !== prev.waiting && next.waiting === 'gate') announce('The build is ready for your approval.');
    else if (next.waiting !== prev.waiting && next.waiting === 'client') announce('The team is waiting for your reply.');
    else if (next.phase === 'done' && prev.phase !== 'done') announce('Shipped. The request is done.');
  }, [live, announce]);

  /* ── load ─────────────────────────────────────────────────────────── */

  const reload = useCallback(async () => {
    setLoad('loading');
    try {
      const t = await api.getTask(taskId);
      reconcile(t, false);
      setLoad('ready');
      pollNowRef.current();
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 404) setLoad('notFound');
      else { setLoadError(messageOf(e)); setLoad('error'); }
    }
  }, [taskId, reconcile]);

  useEffect(() => {
    taskRef.current = null;
    setTask(null);
    setRunning(false);
    runningRef.current = false;
    setOffline(false);
    live.end();
    void reload();
  }, [taskId, reload, live]);

  /* ── the watch loop ───────────────────────────────────────────────── */

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    let busy = false;
    let again = false;
    let failures = 0;
    let lastStep: string | null = null;
    // Nudging a stalled chain.
    let dueSince = 0;
    let nudges = 0;
    let nudgeAt = 0;

    const isDue = (t: Task | null) => !!t && llmReady && !t.archived && nextAgent(t) !== null;
    const delay = () => (runningRef.current || isDue(taskRef.current) ? FAST_MS : SLOW_MS);

    const schedule = () => {
      window.clearTimeout(timer);
      if (stopped || document.hidden) return;
      timer = window.setTimeout(() => void poll(), delay());
    };

    const step = async (state: LiveState) => {
      const before = taskRef.current;
      if (!before) return;
      // The task changed: take it first, so a finished step hands over before the next one shows.
      if (state.updatedAt !== before.updatedAt) {
        const fresh = await api.getTask(taskId);
        if (stopped) return;
        reconcile(fresh, !state.running);
        dueSince = 0;
        nudges = 0;
      } else if (!state.running && live.get().agent) {
        live.end();
      }

      runningRef.current = state.running;
      setRunning(state.running);
      if (state.live) {
        const key = `${state.live.agent}:${state.live.startedAt}`;
        if (key !== lastStep) {
          lastStep = key;
          announce(`${AGENTS[state.live.agent].name} is ${PHASE_VERB[state.live.phase]}.`);
        }
        live.sync(state.live, delay());
      }

      // A step is due and nothing is running it: after a grace period, nudge the server.
      const now = Date.now();
      if (!state.running && isDue(taskRef.current)) {
        dueSince ||= now;
        if (now - dueSince >= NUDGE_AFTER_MS && now >= nudgeAt) {
          nudges += 1;
          nudgeAt = now + Math.min(NUDGE_AFTER_MS * 2 ** nudges, NUDGE_MAX_MS);
          const t = await api.run(taskId).catch(() => null);
          if (t && !stopped) reconcile(t, false);
        }
      } else {
        dueSince = 0;
        if (state.running) { nudges = 0; nudgeAt = 0; }
      }
    };

    const poll = async () => {
      if (stopped) return;
      if (busy) { again = true; return; }
      if (!taskRef.current) { schedule(); return; }
      busy = true;
      try {
        await step(await api.live(taskId));
        failures = 0;
        setOffline(false);
      } catch (e) {
        if (e instanceof ApiFailure && e.status === 404) setLoad('notFound');
        else if (++failures > QUIET_FAILURES) setOffline(true);
      } finally {
        busy = false;
        if (again) { again = false; void poll(); } else schedule();
      }
    };

    pollNowRef.current = () => { window.clearTimeout(timer); void poll(); };
    const onVisible = () => { if (!document.hidden) pollNowRef.current(); else window.clearTimeout(timer); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    schedule();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      pollNowRef.current = () => {};
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [taskId, llmReady, live, reconcile, announce]);

  useEffect(() => () => live.end(), [live]);

  /* ── client actions ───────────────────────────────────────────────── */

  /** Run an action that returns the saved task, take it, and look for the step it started. */
  const act = useCallback(async (call: () => Promise<Task>): Promise<string | null> => {
    try {
      reconcile(await call(), false);
      pollNowRef.current();
      return null;
    } catch (e) {
      return messageOf(e);
    }
  }, [reconcile]);

  const send = useCallback((text: string, attachments: Attachment[] = []) =>
    act(() => api.sendMessage(taskId, text, attachments.map((a) => a.id))), [act, taskId]);

  const decide = useCallback(async (decision: 'approve' | 'return', note: string) => {
    const err = await act(() => api.decide(taskId, decision, note));
    if (!err) announce(decision === 'approve' ? 'Approved. Relay is shipping it.' : 'Returned to the team.');
    return err;
  }, [act, taskId, announce]);

  /** Clear a failed step so it runs again, or nudge a stalled one. */
  const retry = useCallback(() =>
    act(() => (taskRef.current?.messages.at(-1)?.kind === 'error' ? api.retry(taskId) : api.run(taskId))), [act, taskId]);

  const update = useCallback(async (patch: { title?: string; priority?: Priority; archived?: boolean; paused?: boolean }): Promise<string | null> => {
    const before = taskRef.current;
    if (!before) return null;
    // Optimistic, without touching updatedAt, so the server's copy still wins when it arrives.
    const optimistic = { ...before, ...patch };
    taskRef.current = optimistic;
    setTask(optimistic);
    try {
      reconcile(await api.updateTask(taskId, patch), false);
      pollNowRef.current();
      return null;
    } catch (e) {
      if (taskRef.current === optimistic) { taskRef.current = before; setTask(before); }
      return messageOf(e);
    }
  }, [taskId, reconcile]);

  const setPaused = useCallback(async (paused: boolean): Promise<string | null> => {
    const err = await update({ paused });
    if (!err) {
      announce(paused
        ? runningRef.current ? 'Paused. The step already running finishes first.' : 'Paused.'
        : 'Resumed.');
    }
    return err;
  }, [update, announce]);

  const status: RunStatus = running ? 'running' : task?.messages.at(-1)?.kind === 'error' ? 'failed' : 'idle';
  const due = task !== null && !task.archived && nextAgent(task) !== null;

  return {
    task, load, loadError, reload,
    status, offline, paused: task?.paused ?? false, setPaused,
    live, streamed, activity, announcement,
    due, send, decide, retry, update,
  };
}

export type TaskRunner = ReturnType<typeof useTaskRunner>;
