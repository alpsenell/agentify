/**
 * PUT /api/stores/:id/repo {owner, repo, baseBranch, themeRoot} — bind a
 * theme repository to a store after checking the app can see it, the branch
 * exists and the folder is a theme; returns the Workspace.
 * DELETE /api/stores/:id/repo — unbind it; returns the Workspace.
 */
import type { APIRoute } from 'astro';
import { requireOwner, requireSession } from '../../../../server/auth';
import { bindRepo, unbindRepo } from '../../../../server/github';
import { handle, json, readBody, sameOrigin } from '../../../../server/http';

export const prerender = false;

export const PUT: APIRoute = ({ params, request, cookies }) =>
  handle(async () => {
    sameOrigin(request);
    const { user, workspace } = await requireSession(cookies);
    requireOwner(user);
    return json(await bindRepo(workspace, params.id ?? '', await readBody(request)));
  });

export const DELETE: APIRoute = ({ params, request, cookies }) =>
  handle(async () => {
    sameOrigin(request);
    const { user, workspace } = await requireSession(cookies);
    requireOwner(user);
    return json(await unbindRepo(workspace, params.id ?? ''));
  });
