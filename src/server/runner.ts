/**
 * Runs the team on a task without anyone watching. Each step is its own
 * function invocation: a step finishes, saves, and asks the server to start
 * the next one, so a long pipeline never outlives a serverless function and
 * keeps going when the client closes the tab.
 *
 * While a step runs, what the agent has produced so far is written to a
 * small "live" record that the app polls (GET /api/tasks/:id/live).
 */
import { waitUntil } from '@vercel/functions';
import { nextAgent, settle } from '../agency/flow';
import type { LiveState, LiveStep, Task } from '../agency/types';
import { describeFailure, runStep, type StepEvent } from './agents/run';
import { HttpError, signValue, verifyValue } from './auth';
import { recordUsage } from './billing';
import { notifyNeedsClient } from './notify';
import { getTask, getWorkspace, isRunning, lockTask, newMessage, storeOf, unlockTask } from './repo';
import { getStore } from './storage';

const liveKey = (taskId: string) => `live:${taskId}`;
/** How often the live record is written while text streams in. */
const LIVE_WRITE_MS = 500;
/** Signed internal calls are valid for this long. */
const KICK_TTL_MS = 60_000;

/** Let work continue after the response is sent (Vercel), or simply run it (anywhere else). */
export function background(work: Promise<unknown>): void {
  const guarded = work.catch((err) => console.error(err));
  try {
    waitUntil(guarded);
  } catch {
    // Not on Vercel: the promise runs on its own.
  }
}

/* ── starting a step ───────────────────────────────────────────────── */

const kickPayload = (workspaceId: string, taskId: string, at: number) => `step:${workspaceId}:${taskId}:${at}`;

/**
 * Ask the server to run the next step of a task in a fresh invocation.
 * Safe to call when nothing is due or a step is already running: the step
 * endpoint checks both.
 */
export function kick(origin: string, workspaceId: string, taskId: string): void {
  const at = Date.now();
  background(
    fetch(`${origin}/api/internal/step`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, taskId, at, sig: signValue(kickPayload(workspaceId, taskId, at)) }),
    }),
  );
}

/** Check an internal step request really came from this server. */
export function verifyKick(body: Record<string, unknown>): { workspaceId: string; taskId: string } {
  const { workspaceId, taskId, at, sig } = body;
  if (
    typeof workspaceId !== 'string' || typeof taskId !== 'string' || typeof at !== 'number' || typeof sig !== 'string' ||
    Math.abs(Date.now() - at) > KICK_TTL_MS || !verifyValue(kickPayload(workspaceId, taskId, at), sig)
  ) {
    throw new HttpError(403, 'forbidden', 'Not allowed.');
  }
  return { workspaceId, taskId };
}

/** Start the team on a task if a step is due and none is running. */
export function kickIfDue(origin: string, task: Task): void {
  if (nextAgent(task) && !isRunning(task)) kick(origin, task.workspaceId, task.id);
}

/* ── one step ──────────────────────────────────────────────────────── */

/** Run one step of a task to completion, save it, and start the next if there is one. */
export async function runOne(origin: string, workspaceId: string, taskId: string): Promise<void> {
  let task: Task;
  try {
    task = await lockTask(workspaceId, taskId);
  } catch {
    return; // Already running, or gone.
  }
  if (!nextAgent(task)) {
    await unlockTask(task);
    return;
  }

  const store = getStore();
  const live: LiveStep = { agent: nextAgent(task)!, phase: task.phase, startedAt: Date.now(), text: '', tools: [] };
  let lastWrite = 0;
  let writing: Promise<void> = Promise.resolve();
  const flush = (force = false) => {
    const now = Date.now();
    if (!force && now - lastWrite < LIVE_WRITE_MS) return;
    lastWrite = now;
    // Chain the writes so an older snapshot can never land after a newer one.
    const snapshot = JSON.stringify(live);
    writing = writing.then(() => store.set(liveKey(taskId), JSON.parse(snapshot) as LiveStep)).catch(() => {});
  };
  const emit = (event: StepEvent) => {
    switch (event.type) {
      case 'start': live.agent = event.agent; live.phase = event.phase; flush(true); break;
      case 'text': live.text += event.delta; flush(); break;
      case 'tool': {
        const running = live.tools.findLast((t) => t.name === event.name && t.label === event.label && t.state === 'running');
        if (running && event.state !== 'running') running.state = event.state;
        else live.tools.push({ name: event.name, label: event.label, state: event.state });
        flush(true);
        break;
      }
      case 'message': break; // Saved with the task.
    }
  };

  // What the task looked like before the step, to restore if it fails half-way.
  const before = JSON.stringify(task);
  const usageBefore = { ...task.usage };
  const workspace = await getWorkspace(workspaceId);
  let result = task;
  try {
    if (!workspace) throw new HttpError(404, 'not_found', 'That workspace no longer exists.');
    await runStep(task, workspace, storeOf(workspace, task), emit);
  } catch (err) {
    // Keep nothing from the failed step except its cost, and say what happened in the thread.
    result = JSON.parse(before) as Task;
    result.usage = task.usage;
    result.messages.push(newMessage('system', 'client', 'error', describeFailure(err)));
    settle(result);
  }

  flush(true);
  await writing;

  // The client may have written while the step ran (a note, a pause, a rename): keep it.
  const latest = await getTask(workspaceId, taskId).catch(() => null);
  if (latest) {
    const atLock = JSON.parse(before) as Task;
    const known = new Set([...atLock.messages, ...result.messages].map((m) => m.id));
    for (const m of latest.messages) if (!known.has(m.id)) result.messages.push(m);
    result.paused = latest.paused;
    result.archived = latest.archived;
    result.priority = latest.priority;
    // A rename by the client wins over the title the brief set.
    if (latest.title !== atLock.title) result.title = latest.title;
    settle(result);
  }
  await unlockTask(result);
  await store.delete(liveKey(taskId));

  if (workspace) {
    await recordUsage(workspace, {
      input: result.usage.input - usageBefore.input,
      output: result.usage.output - usageBefore.output,
    }).catch((err) => console.error(err));
    // The team has stopped on a person: tell them, since they may not be looking.
    if (result.waiting === 'client' || result.waiting === 'gate') {
      await notifyNeedsClient(workspace, result, origin).catch((err) => console.error(err));
    }
  }
  if (nextAgent(result)) kick(origin, workspaceId, taskId);
}

/** The cheap poll: has the task changed, and what is the running step producing? */
export async function liveState(workspaceId: string, taskId: string): Promise<LiveState> {
  const task = await getTask(workspaceId, taskId);
  const running = isRunning(task);
  return {
    updatedAt: task.updatedAt,
    running,
    live: running ? await getStore().get<LiveStep>(liveKey(taskId)) : null,
  };
}
