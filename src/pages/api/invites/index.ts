/** POST /api/invites {email} → {invite, link, emailed}. Owner only. */
import type { APIRoute } from 'astro';
import { requireOwner, requireSession } from '../../../server/auth';
import { handle, json, readBody, sameOrigin } from '../../../server/http';
import { invite } from '../../../server/members';

export const prerender = false;

export const POST: APIRoute = ({ request, cookies }) =>
  handle(async () => {
    sameOrigin(request);
    const { user, workspace } = await requireSession(cookies);
    requireOwner(user);
    const body = await readBody(request);
    return json(await invite(user, workspace, body.email, new URL(request.url).origin), 201);
  });
