/** POST /api/auth/signup — create an account and its workspace, and sign in. */
import type { APIRoute } from 'astro';
import { signup } from '../../../server/auth';
import { handle, json, readBody, sameOrigin } from '../../../server/http';

export const prerender = false;

export const POST: APIRoute = ({ request, cookies }) =>
  handle(async () => {
    sameOrigin(request);
    const body = await readBody(request);
    return json(await signup(cookies, { email: body.email, password: body.password, name: body.name, workspaceName: body.workspaceName }), 201);
  });
