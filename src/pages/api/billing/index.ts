/** GET /api/billing — the plan, this period's usage, and the plans on offer. Works without Stripe. */
import type { APIRoute } from 'astro';
import { requireSession } from '../../../server/auth';
import { billingSummary } from '../../../server/billing';
import { handle, json } from '../../../server/http';

export const prerender = false;

export const GET: APIRoute = ({ cookies }) =>
  handle(async () => {
    const { workspace } = await requireSession(cookies);
    return json(await billingSummary(workspace));
  });
