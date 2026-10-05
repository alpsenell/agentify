/** POST /api/stores {label, env} — add a store to the workspace (owner only); returns the workspace. */
import type { APIRoute } from 'astro';
import { requireOwner, requireSession } from '../../../server/auth';
import { handle, json, readBody, sameOrigin } from '../../../server/http';
import { createStore } from '../../../server/shopify/stores';

export const prerender = false;

export const POST: APIRoute = ({ request, cookies }) =>
  handle(async () => {
    sameOrigin(request);
    const { user, workspace } = await requireSession(cookies);
    requireOwner(user);
    const body = await readBody(request);
    return json(await createStore(workspace, { label: body.label, env: body.env }), 201);
  });
