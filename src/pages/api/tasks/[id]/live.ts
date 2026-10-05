/** GET /api/tasks/:id/live — the cheap poll: has the task changed, and what is the running step producing? */
import type { APIRoute } from 'astro';
import { requireSession } from '../../../../server/auth';
import { handle, json } from '../../../../server/http';
import { liveState } from '../../../../server/runner';

export const prerender = false;

export const GET: APIRoute = ({ params, cookies }) =>
  handle(async () => {
    const { workspace } = await requireSession(cookies);
    return json(await liveState(workspace.id, params.id ?? ''));
  });
