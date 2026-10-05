/**
 * The two emails Agentify sends, as plain text plus minimal HTML. Every
 * string that came from a person (names, workspace, request title, Atlas's
 * question) is escaped in the HTML and stripped of line breaks in subjects.
 * No imports from the rest of the server, so it is tested on its own.
 */
import type { Message, Task } from '../../agency/types';

export interface Email {
  subject: string;
  text: string;
  html: string;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** One line, no control characters, bounded: safe for a subject. */
const line = (value: string, max = 120) => {
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Trim long text at a word boundary. */
export function clip(value: string, max: number): string {
  const text = value.trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const date = (at: number) => new Date(at).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

/** A small, client-safe HTML shell. `body` must already be escaped. */
function layout(body: string, footer: string): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f7f6f3;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c1915;font-size:15px;line-height:1.55">
<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e6e2db;border-radius:12px;padding:28px">
<div style="font-weight:700;font-size:16px;margin-bottom:18px">Agentify</div>
${body}
</div>
<p style="max-width:520px;margin:14px auto 0;font-size:12px;color:#8a847b">${footer}</p>
</body></html>`;
}

const button = (href: string, label: string) =>
  `<p style="margin:22px 0"><a href="${escapeHtml(href)}" style="display:inline-block;background:#d9480f;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px">${escapeHtml(label)}</a></p>`;
const p = (html: string) => `<p style="margin:0 0 12px">${html}</p>`;
const quote = (text: string) =>
  `<blockquote style="margin:0 0 12px;padding:10px 14px;border-left:3px solid #d9480f;background:#faf9f7;border-radius:6px;white-space:pre-wrap">${escapeHtml(text)}</blockquote>`;

/* ── invitation ────────────────────────────────────────────────────── */

export function invitationEmail(input: { inviter: string; workspace: string; link: string; expiresAt: number }): Email {
  const inviter = line(input.inviter, 80), workspace = line(input.workspace, 80);
  const expires = date(input.expiresAt);
  return {
    subject: `${inviter} invited you to ${workspace} on Agentify`,
    text: [
      `${inviter} invited you to join ${workspace} on Agentify, where a team of AI agents takes Shopify requests from brief to preview theme.`,
      '',
      `Accept the invitation: ${input.link}`,
      '',
      `The link works once and expires on ${expires}. If you were not expecting this, you can ignore this email.`,
    ].join('\n'),
    html: layout(
      p(`<strong>${escapeHtml(inviter)}</strong> invited you to join <strong>${escapeHtml(workspace)}</strong> on Agentify, where a team of AI agents takes Shopify requests from brief to preview theme.`)
        + button(input.link, 'Accept the invitation')
        + p(`<span style="color:#55504a;font-size:13px">The link works once and expires on ${escapeHtml(expires)}. If the button does not work, paste this into your browser:<br><span style="word-break:break-all">${escapeHtml(input.link)}</span></span>`),
      'If you were not expecting this, you can ignore this email.',
    ),
  };
}

/* ── a request needs you ───────────────────────────────────────────── */

export type NeedKind = 'question' | 'approval' | 'failed' | 'reply';

/** What the task is waiting on the client for, from its state and last message. */
export function needOf(task: Task): { kind: NeedKind; message: Message | null } {
  const last = task.messages.at(-1) ?? null;
  if (last?.kind === 'error') return { kind: 'failed', message: last };
  if (task.waiting === 'gate') return { kind: 'approval', message: last };
  if (last && last.from === 'atlas' && last.to === 'client') return { kind: 'question', message: last };
  return { kind: 'reply', message: last };
}

export function needsYouEmail(input: { task: Task; workspace: string; link: string; settingsLink: string }): Email {
  const { task } = input;
  const title = line(task.title, 90);
  const ref = `#${task.number} ${title}`;
  const { kind, message } = needOf(task);
  const excerpt = message ? clip(message.text, 700) : '';

  const parts: Record<NeedKind, { subject: string; lead: string; action: string; showText: boolean }> = {
    question: { subject: `${ref}: Atlas has a question`, lead: `Atlas has a question about request ${ref}:`, action: 'Answer in the thread', showText: true },
    approval: {
      subject: `${ref} is ready for your approval`,
      lead: `The team has built and reviewed request ${ref}. It is waiting for your approval before Relay ships it to a preview theme.`,
      action: 'Review and approve', showText: false,
    },
    failed: { subject: `${ref} stopped: a step failed`, lead: `A step on request ${ref} failed:`, action: 'Open the request to retry', showText: true },
    reply: { subject: `${ref} is waiting for you`, lead: `Request ${ref} is waiting for your reply.`, action: 'Open the request', showText: false },
  };
  const m = parts[kind];
  const footer = `You get this because email notifications are on for you in ${line(input.workspace, 80)}. Turn them off in Settings → Members: ${input.settingsLink}`;

  return {
    subject: m.subject,
    text: [m.lead, ...(m.showText && excerpt ? ['', excerpt.split('\n').map((l) => `> ${l}`).join('\n')] : []), '', `${m.action}: ${input.link}`, '', '—', footer].join('\n'),
    html: layout(
      p(escapeHtml(m.lead)) + (m.showText && excerpt ? quote(excerpt) : '') + button(input.link, m.action),
      `You get this because email notifications are on for you in ${escapeHtml(line(input.workspace, 80))}. <a href="${escapeHtml(input.settingsLink)}" style="color:#8a847b">Turn them off</a>.`,
    ),
  };
}
