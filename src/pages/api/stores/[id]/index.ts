/**
 * PATCH /api/stores/:id {label?, env?} — rename a store or change its environment.
 * DELETE /api/stores/:id — disconnect and delete it (owner only; refused while it has open requests).
 * Both return the workspace.
 */
import type { APIRoute } from 'astro';
import { requireOwner, requireSession } from '../../../../server/auth';
import { handle, json, readBody, sameOrigin } from '../../../../server/http';
import { deleteStore, updateStore } from '../../../../server/shopify/stores';

export const prerender = false;

export const PATCH: APIRoute = ({ request, cookies, params }) =>
  handle(async () => {
    sameOrigin(request);
    const { user, workspace } = await requireSession(cookies);
    requireOwner(user);
    const body = await readBody(request);
    return json(await updateStore(workspace, params.id, { label: body.label, env: body.env }));
  });

export const DELETE: APIRoute = ({ request, cookies, params }) =>
  handle(async () => {
    sameOrigin(request);
    const { user, workspace } = await requireSession(cookies);
    requireOwner(user);
    return json(await deleteStore(workspace, params.id));
  });
