/** POST /api/tasks/:id/retry — clear a failed step so it can run again. */
import type { APIRoute } from 'astro';
import { requireSession } from '../../../../server/auth';
import { handle, json, sameOrigin } from '../../../../server/http';
import { getTask, saveTask } from '../../../../server/repo';
import { kickIfDue } from '../../../../server/runner';
import { retryStep } from '../../../../server/tasks';

export const prerender = false;

export const POST: APIRoute = ({ params, request, cookies }) =>
  handle(async () => {
    sameOrigin(request);
    const { workspace } = await requireSession(cookies);
    const task = await getTask(workspace.id, params.id ?? '');
    
    retryStep(task);
    await saveTask(task);
    kickIfDue(new URL(request.url).origin, task);
    return json(task);
  });
