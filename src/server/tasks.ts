/**
 * What the client can do to a task: write in the thread, decide at the gate,
 * retry a failed step, edit its details. The agents' side is in agents/run.ts.
 */
import { PRIORITIES, type Attachment, type Priority, type Task } from '../agency/types';
import { settle } from '../agency/flow';
import { HttpError } from './auth';
import { newMessage } from './repo';

const busy = (task: Task) => task.lockedUntil > Date.now();

export function addClientMessage(task: Task, text: unknown, attachments: Attachment[] = []): void {
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body && !attachments.length) throw new HttpError(400, 'empty_message', 'Write a message first.');
  if (body.length > 20_000) throw new HttpError(400, 'too_long', 'Keep the message under 20,000 characters.');
  if (task.archived) throw new HttpError(409, 'archived', 'This request is archived.');

  // A message after a failed step replaces the failure: the team picks up from the message.
  if (task.messages.at(-1)?.kind === 'error') task.messages.pop();
  task.messages.push(newMessage('client', 'atlas', 'chat', body, attachments));
  settle(task);
}

export function decideGate(task: Task, decision: unknown, note: unknown): void {
  if (task.phase !== 'gate') throw new HttpError(409, 'not_at_gate', 'This request is not waiting for your approval.');
  if (busy(task)) throw new HttpError(409, 'locked', 'The team is working on this request. Try again in a moment.');
  const text = typeof note === 'string' ? note.trim().slice(0, 5000) : '';

  if (decision === 'approve') {
    task.phase = 'ship';
    task.messages.push(newMessage('client', 'relay', 'gate', text ? `Approved. ${text}` : 'Approved.'));
  } else if (decision === 'return') {
    if (!text) throw new HttpError(400, 'reason_required', 'Say what needs to change.');
    task.phase = 'build';
    task.review = null;
    task.messages.push(newMessage('client', 'volt', 'gate', `Returned: ${text}`));
  } else {
    throw new HttpError(400, 'bad_request', 'Decision must be "approve" or "return".');
  }
  settle(task);
}

/** Drop a trailing failure so the same step runs again. */
export function retryStep(task: Task): void {
  if (task.messages.at(-1)?.kind !== 'error') throw new HttpError(409, 'nothing_to_retry', 'There is no failed step to retry.');
  task.messages.pop();
  settle(task);
}

export function editTask(task: Task, patch: Record<string, unknown>): void {
  if (patch.title !== undefined) {
    const title = typeof patch.title === 'string' ? patch.title.trim().slice(0, 120) : '';
    if (!title) throw new HttpError(400, 'invalid_title', 'The title cannot be empty.');
    task.title = title;
  }
  if (patch.priority !== undefined) {
    if (!PRIORITIES.includes(patch.priority as Priority)) throw new HttpError(400, 'invalid_priority', 'Unknown priority.');
    task.priority = patch.priority as Priority;
  }
  if (patch.paused !== undefined) {
    if (typeof patch.paused !== 'boolean') throw new HttpError(400, 'bad_request', '"paused" must be true or false.');
    task.paused = patch.paused;
  }
  if (patch.archived !== undefined) {
    if (typeof patch.archived !== 'boolean') throw new HttpError(400, 'bad_request', '"archived" must be true or false.');
    task.archived = patch.archived;
  }
  settle(task);
}
