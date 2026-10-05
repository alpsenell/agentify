/** POST /api/billing/portal → {url}: Stripe's customer portal (card, invoices, cancel). Owner only. */
import type { APIRoute } from 'astro';
import { requireOwner, requireSession } from '../../../server/auth';
import { openPortal } from '../../../server/billing';
import { handle, json, sameOrigin } from '../../../server/http';

export const prerender = false;

export const POST: APIRoute = ({ request, cookies }) =>
  handle(async () => {
    sameOrigin(request);
    const { user, workspace } = await requireSession(cookies);
    requireOwner(user);
    return json({ url: await openPortal(workspace, new URL(request.url).origin) });
  });
