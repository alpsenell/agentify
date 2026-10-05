/** GET /api/members — the workspace's members and pending invitations. */
import type { APIRoute } from 'astro';
import { requireSession } from '../../../server/auth';
import { handle, json } from '../../../server/http';
import { membersOf } from '../../../server/members';

export const prerender = false;

export const GET: APIRoute = ({ cookies }) =>
  handle(async () => {
    const { workspace } = await requireSession(cookies);
    return json(await membersOf(workspace.id));
  });
