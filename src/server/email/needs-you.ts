/**
 * "A request needs you": who to tell, and making sure each waiting state is
 * told once. The dedupe key is the task id plus the id of its last message,
 * claimed with setIfAbsent before sending, so two steps finishing together
 * (or a retried invocation) cannot both send. No imports from the rest of
 * the server; notify.ts wires it up.
 */
import type { Task, User, Workspace } from '../../agency/types';
import type { Store as KV } from '../storage';
import { needsYouEmail, type Email } from './messages.ts';

export interface NeedsYouDeps {
  kv: KV;
  members: (workspaceId: string) => Promise<User[]>;
  send: (to: string, email: Email, idempotencyKey: string) => Promise<unknown>;
}

const sentKey = (taskId: string, messageId: string) => `notified:${taskId}:${messageId}`;

/** Returns how many people were emailed. Never throws. */
export async function notifyWaiting(deps: NeedsYouDeps, workspace: Workspace, task: Task, origin: string): Promise<number> {
  try {
    if (task.waiting !== 'client' && task.waiting !== 'gate') return 0;
    if (task.archived) return 0;
    const last = task.messages.at(-1);
    if (!last) return 0;
    // The client's own message never needs telling them about.
    if (last.from === 'client') return 0;
    const recipients = (await deps.members(workspace.id)).filter((u) => u.notify);
    if (!recipients.length) return 0;

    const key = sentKey(task.id, last.id);
    if (!(await deps.kv.setIfAbsent(key, Date.now()))) return 0;

    const email = needsYouEmail({
      task, workspace: workspace.name, link: `${origin}/dashboard/t/${task.id}`, settingsLink: `${origin}/dashboard/settings#members`,
    });
    let sent = 0;
    for (const user of recipients) {
      try {
        await deps.send(user.email, email, `needs-you/${task.id}/${last.id}/${user.id}`);
        sent++;
      } catch (err) {
        console.error(`Could not email ${user.email} about request #${task.number}:`, err);
      }
    }
    // Nobody got it (provider down): release the claim so a later step can try again.
    if (sent === 0) await deps.kv.delete(key).catch(() => {});
    return sent;
  } catch (err) {
    console.error('notifyWaiting failed:', err);
    return 0;
  }
}
