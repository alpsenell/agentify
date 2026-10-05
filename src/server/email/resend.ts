/**
 * Sending email through Resend's REST API (POST /emails), without the SDK.
 * Configured by RESEND_API_KEY and EMAIL_FROM ("Agentify <team@your-domain>",
 * a sender on a domain verified in Resend). No imports from the rest of the
 * server, so it runs under plain Node in tests.
 */
import type { Email } from './messages.ts';

export interface EmailConfig {
  apiKey: string;
  from: string;
}

export class EmailError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Send one email. `idempotencyKey` makes Resend drop a repeat of the same
 * send within 24 hours, a second guard behind our own dedupe.
 */
export async function sendEmail(cfg: EmailConfig, to: string, email: Email, idempotencyKey?: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
        // Resend refuses requests without one.
        'User-Agent': 'agentify/1.0',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey.slice(0, 256) } : {}),
      },
      body: JSON.stringify({ from: cfg.from, to: [to], subject: email.subject, text: email.text, html: email.html }),
    });
  } catch (err) {
    throw new EmailError(0, `Could not reach Resend: ${(err as Error).message}`);
  }
  const data = (await res.json().catch(() => null)) as { id?: string; message?: string; name?: string } | null;
  if (!res.ok || !data?.id) throw new EmailError(res.status, `Resend refused the email (${res.status} ${data?.name ?? ''}): ${data?.message ?? 'no detail'}`);
  return data.id;
}
