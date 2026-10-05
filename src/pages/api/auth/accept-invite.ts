/** POST /api/auth/accept-invite {token, name, password} — join the invited workspace and sign in. */
import type { APIRoute } from 'astro';
import { handle, json, readBody, sameOrigin } from '../../../server/http';
import { accept } from '../../../server/members';

export const prerender = false;

export const POST: APIRoute = ({ request, cookies }) =>
  handle(async () => {
    sameOrigin(request);
    const body = await readBody(request);
    return json(await accept(cookies, { token: body.token, name: body.name, password: body.password }), 201);
  });
