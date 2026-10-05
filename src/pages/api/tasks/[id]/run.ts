/**
 * POST /api/tasks/:id/run — make sure the team is working on this request.
 * The server starts steps by itself; this is the nudge for a request whose
 * chain stopped (a step died, or the server restarted mid-run).
 */
import type { APIRoute } from 'astro';
import { requireSession } from '../../../../server/auth';
import { handle, json, sameOrigin } from '../../../../server/http';
import { getTask } from '../../../../server/repo';
import { kickIfDue } from '../../../../server/runner';

export const prerender = false;

export const POST: APIRoute = ({ params, request, cookies }) =>
  handle(async () => {
    sameOrigin(request);
    const { workspace } = await requireSession(cookies);
    const task = await getTask(workspace.id, params.id ?? '');
    kickIfDue(new URL(request.url).origin, task);
    return json(task);
  });
