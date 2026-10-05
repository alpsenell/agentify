/**
 * The step running right now, as the server reports it in each poll, kept
 * outside React state so it re-renders only the live bubble (not the
 * thread). The text only grows within a step, so each poll sets a new
 * target and the bubble types its way there, a few characters per frame,
 * paced to arrive about when the next poll does.
 */
import { useSyncExternalStore } from 'react';
import type { AgentId, LiveStep, LiveTool, Phase } from '../../agency/types';

export interface ToolLine {
  id: number;
  name: string;
  label: string;
  state: LiveTool['state'];
}

export interface LiveView {
  agent: AgentId | null;
  phase: Phase | null;
  /** Identifies the step: a new value means a new step started. */
  key: string | null;
  /** The text revealed so far. */
  text: string;
  tools: ToolLine[];
}

const IDLE: LiveView = { agent: null, phase: null, key: null, text: '', tools: [] };

/** Slowest reveal, so a short delta still reads as typing. */
const MIN_CHARS_PER_MS = 0.04;
/** Never fall more than this far behind the server (after a hidden tab, say). */
const MAX_LAG_CHARS = 1200;

export type LiveStore = ReturnType<typeof createLiveStore>;

export function createLiveStore() {
  let state = IDLE;
  let target = '';
  let rate = MIN_CHARS_PER_MS;
  let frame = 0;
  let last = 0;
  let toolSeq = 0;
  const listeners = new Set<() => void>();
  const set = (next: LiveView) => { state = next; listeners.forEach((fn) => fn()); };

  const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const stop = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };

  // One state change per frame, however many characters it reveals.
  const tick = (now: number) => {
    frame = 0;
    const shown = state.text.length;
    if (shown >= target.length) return;
    const elapsed = last ? Math.min(now - last, 100) : 16;
    last = now;
    const step = Math.max(1, Math.round(elapsed * rate));
    let end = Math.min(target.length, shown + step);
    // Finish the word in progress, so the text does not flicker mid-word.
    const space = target.indexOf(' ', end);
    if (space !== -1 && space - end < 12) end = space + 1;
    set({ ...state, text: target.slice(0, end) });
    if (end < target.length) frame = requestAnimationFrame(tick);
  };

  return {
    get: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },

    /**
     * Take a snapshot from a poll. `paceMs` is when the next snapshot is due:
     * the reveal is paced to finish around then.
     */
    sync(step: LiveStep, paceMs: number) {
      const key = `${step.agent}:${step.startedAt}`;
      const fresh = key !== state.key;
      if (fresh) {
        stop();
        target = '';
        last = 0;
      }

      // Tool lines keep their ids across polls, matched by position.
      const prev = fresh ? [] : state.tools;
      const tools = step.tools.map((t, i) => {
        const old = prev[i];
        return old && old.name === t.name && old.label === t.label && old.state === t.state
          ? old
          : { id: old && old.name === t.name ? old.id : ++toolSeq, name: t.name, label: t.label, state: t.state };
      });
      const toolsChanged = tools.length !== prev.length || tools.some((t, i) => t !== prev[i]);

      // The text only grows within a step; anything else (a retry) starts over.
      let text = fresh ? '' : state.text;
      if (!step.text.startsWith(text)) text = '';
      target = step.text;
      if (reduced() || target.length - text.length > MAX_LAG_CHARS) text = target.slice(0, Math.max(text.length, target.length - MAX_LAG_CHARS));
      if (reduced()) text = target;
      rate = Math.max(MIN_CHARS_PER_MS, (target.length - text.length) / Math.max(paceMs, 200));

      if (fresh || toolsChanged || text !== state.text || step.phase !== state.phase) {
        set({ agent: step.agent, phase: step.phase, key, text, tools });
      }
      if (!frame && text.length < target.length) { last = 0; frame = requestAnimationFrame(tick); }
    },

    /** Reveal whatever is left at once (the step is over and its message is about to replace the bubble). */
    flush() {
      stop();
      if (state.text !== target) set({ ...state, text: target });
    },

    /** The tool lines of the step, to keep under the message it produced. */
    tools: () => state.tools,

    end() {
      stop();
      target = '';
      if (state !== IDLE) set(IDLE);
    },
  };
}

export function useLive(store: LiveStore): LiveView {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
