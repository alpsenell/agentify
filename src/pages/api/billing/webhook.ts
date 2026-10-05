/**
 * POST /api/billing/webhook — Stripe events. The signature is checked over
 * the body exactly as received, so it is read as text and never re-parsed
 * before verification. A 5xx makes Stripe retry; a 4xx means "do not".
 */
import type { APIRoute } from 'astro';
import { receiveWebhook } from '../../../server/billing';
import { handle, json } from '../../../server/http';

export const prerender = false;

export const POST: APIRoute = ({ request }) =>
  handle(async () => {
    const raw = await request.text();
    const outcome = await receiveWebhook(raw, request.headers.get('stripe-signature'));
    return json({ received: true, outcome });
  });
