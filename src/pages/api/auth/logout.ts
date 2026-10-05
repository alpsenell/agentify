/** POST /api/auth/logout — end the session. */
import type { APIRoute } from 'astro';
import { clearSession } from '../../../server/auth';
import { handle, json, sameOrigin } from '../../../server/http';

export const prerender = false;

export const POST: APIRoute = ({ request, cookies }) =>
  handle(async () => {
    sameOrigin(request);
    clearSession(cookies);
    return json(null, 204);
  });
