/**
 * DELETE /api/github — forget the workspace's GitHub App installation and
 * every store's repository; returns the Workspace. The app stays installed
 * on GitHub (uninstalling is done there).
 */
import type { APIRoute } from 'astro';
import { requireOwner, requireSession } from '../../../server/auth';
import { disconnectGithub } from '../../../server/github';
import { handle, json, sameOrigin } from '../../../server/http';

export const prerender = false;

export const DELETE: APIRoute = ({ request, cookies }) =>
  handle(async () => {
    sameOrigin(request);
    const { user, workspace } = await requireSession(cookies);
    requireOwner(user);
    return json(await disconnectGithub(workspace));
  });
