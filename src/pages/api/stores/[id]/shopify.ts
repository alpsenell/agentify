/**
 * PUT /api/stores/:id/shopify {domain, token} — connect the store with a pasted custom-app Admin API token.
 * DELETE /api/stores/:id/shopify — disconnect it and delete the saved token.
 * Owner only; both return the workspace.
 */
import type { APIRoute } from 'astro';
import { requireOwner, requireSession } from '../../../../server/auth';
import { handle, json, readBody, sameOrigin } from '../../../../server/http';
import { getWorkspace } from '../../../../server/repo';
import { connectStore, disconnectStore } from '../../../../server/shopify';
import { findStore } from '../../../../server/shopify/stores';

export const prerender = false;

export const PUT: APIRoute = ({ request, cookies, params }) =>
  handle(async () => {
    sameOrigin(request);
    const { user, workspace } = await requireSession(cookies);
    requireOwner(user);
    const body = await readBody(request);
    await connectStore(workspace, findStore(workspace, params.id), { domain: body.domain, token: body.token });
    return json((await getWorkspace(workspace.id)) ?? workspace);
  });

export const DELETE: APIRoute = ({ request, cookies, params }) =>
  handle(async () => {
    sameOrigin(request);
    const { user, workspace } = await requireSession(cookies);
    requireOwner(user);
    await disconnectStore(workspace, findStore(workspace, params.id));
    return json((await getWorkspace(workspace.id)) ?? workspace);
  });
