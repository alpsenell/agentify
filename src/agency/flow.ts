/**
 * The hand-off rules: who acts next on a task, and what each outcome does to
 * its phase. Pure functions over a Task, so the order the agents work in is
 * decided here and nowhere else. Shared by the server and the app.
 *
 *   discovery   Atlas talks with the client until it can submit a brief
 *   feasibility Forge checks the brief; questions or blockers go back to Atlas
 *   design      Muse writes the UI/UX spec
 *   build       Volt writes the files
 *   review      Sieve checks them; a fail goes back to Volt (limited rounds)
 *   gate        the client approves or returns
 *   ship        Relay deploys to a preview theme
 */
import type { AgentId, Task, Waiting } from './types';

/** Builds Sieve may send back before the work goes to the client regardless. */
export const MAX_BUILD_ROUNDS = 3;

/** The agent that should act now, or null when the task waits on a person. */
export function nextAgent(task: Task): AgentId | null {
  if (task.archived || task.paused) return null;
  const last = task.messages.at(-1);
  // A failed step waits for the client to retry instead of looping on the error.
  if (last?.kind === 'error') return null;

  switch (task.phase) {
    case 'discovery':
      // Atlas answers anything not already answered by Atlas: the client, or Forge's questions.
      return last && last.from === 'atlas' && last.to === 'client' ? null : 'atlas';
    case 'feasibility': return 'forge';
    case 'design': return 'muse';
    case 'build': return 'volt';
    case 'review': return 'sieve';
    case 'ship': return 'relay';
    case 'gate':
    case 'done':
      // A question at the gate, or a change request on finished work, goes to Atlas.
      return last?.from === 'client' && last.kind === 'chat' ? 'atlas' : null;
  }
}

export function waitingOn(task: Task): Waiting {
  if (task.archived) return 'none';
  // Paused work is still the team's to do; it just is not started.
  if (nextAgent({ ...task, paused: false })) return 'agents';
  if (task.phase === 'gate') return 'gate';
  if (task.phase === 'done') return 'none';
  return 'client';
}

/** Recompute the derived `waiting` field after any change. */
export function settle(task: Task): Task {
  task.waiting = waitingOn(task);
  return task;
}
