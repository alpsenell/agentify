/**
 * GET /api/invites/:token — public: what an invitation link is for.
 * DELETE /api/invites/:id — revoke a pending invitation. Owner only.
 * One route file because both live at /api/invites/<segment>; a token and an
 * invitation id never look alike (43-character base64url vs a UUID).
 */
import type { APIRoute } from 'astro';
import { requireOwner, requireSession } from '../../../server/auth';
import { handle, json, sameOrigin } from '../../../server/http';
import { inviteInfo, revoke } from '../../../server/members';

export const prerender = false;

export const GET: APIRoute = ({ params }) => handle(async () => json(await inviteInfo(params.id)));

export const DELETE: APIRoute = ({ request, cookies, params }) =>
  handle(async () => {
    sameOrigin(request);
    const { user, workspace } = await requireSession(cookies);
    requireOwner(user);
    await revoke(workspace.id, params.id ?? '');
    return json(null, 204);
  });
