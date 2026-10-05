/** POST /api/billing/checkout {tier} → {url}: Stripe Checkout for a plan, or the portal's confirm page to switch plans. Owner only. */
import type { APIRoute } from 'astro';
import { requireOwner, requireSession } from '../../../server/auth';
import { startCheckout } from '../../../server/billing';
import { handle, json, readBody, sameOrigin } from '../../../server/http';

export const prerender = false;

export const POST: APIRoute = ({ request, cookies }) =>
  handle(async () => {
    sameOrigin(request);
    const { user, workspace } = await requireSession(cookies);
    requireOwner(user);
    const body = await readBody(request);
    return json({ url: await startCheckout(user, workspace, body.tier, new URL(request.url).origin) });
  });
