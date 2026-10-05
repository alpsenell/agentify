/**
 * Email to people: "a request needs you" and invitations. Sent through
 * Resend when RESEND_API_KEY and EMAIL_FROM are set; otherwise nothing is
 * sent and the app shows invitation links to copy instead. The message text
 * lives in email/messages.ts, the dedupe in email/needs-you.ts.
 */
import type { Task, Workspace } from '../agency/types';
import { listMembers } from './auth';
import { invitationEmail } from './email/messages';
import { notifyWaiting } from './email/needs-you';
import { sendEmail, type EmailConfig } from './email/resend';
import { getStore } from './storage';

const env = (name: string): string | undefined => process.env[name] ?? (import.meta.env?.[name] as string | undefined);

function emailConfig(): EmailConfig | null {
  const apiKey = env('RESEND_API_KEY'), from = env('EMAIL_FROM');
  return apiKey && from ? { apiKey, from } : null;
}

/** Whether an email provider is configured on this server. */
export function emailConfigured(): boolean {
  return emailConfig() !== null;
}

/**
 * Tell the workspace's members (those with notify on) that a request is
 * waiting on them: a question from Atlas, or a build at the gate. `origin`
 * is the site origin for links. Never throws.
 */
export async function notifyNeedsClient(workspace: Workspace, task: Task, origin: string): Promise<void> {
  const cfg = emailConfig();
  if (!cfg) return;
  await notifyWaiting({
    kv: getStore(),
    members: listMembers,
    send: (to, email, key) => sendEmail(cfg, to, email, key),
  }, workspace, task, origin);
}

/** Email an invitation. Returns whether it was sent; never throws (the owner can still copy the link). */
export async function sendInvitation(input: { to: string; inviter: string; workspace: string; link: string; expiresAt: number; inviteId: string }): Promise<boolean> {
  const cfg = emailConfig();
  if (!cfg) return false;
  try {
    await sendEmail(cfg, input.to, invitationEmail(input), `invite/${input.inviteId}`);
    return true;
  } catch (err) {
    console.error(`Could not email the invitation to ${input.to}:`, err);
    return false;
  }
}
