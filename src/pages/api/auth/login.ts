/** POST /api/auth/login — sign in with email and password. */
import type { APIRoute } from 'astro';
import { login } from '../../../server/auth';
import { handle, json, readBody, sameOrigin } from '../../../server/http';

export const prerender = false;

export const POST: APIRoute = ({ request, cookies }) =>
  handle(async () => {
    sameOrigin(request);
    const body = await readBody(request);
    return json({ user: await login(cookies, { email: body.email, password: body.password }) });
  });
