/** DELETE /api/members/:userId — remove a member and their account. Owner only; not the owner themselves. */
import type { APIRoute } from 'astro';
import { requireOwner, requireSession } from '../../../server/auth';
import { handle, json, sameOrigin } from '../../../server/http';
import { remove } from '../../../server/members';

export const prerender = false;

export const DELETE: APIRoute = ({ request, cookies, params }) =>
  handle(async () => {
    sameOrigin(request);
    const { user } = await requireSession(cookies);
    requireOwner(user);
    await remove(user, params.userId ?? '');
    return json(null, 204);
  });
