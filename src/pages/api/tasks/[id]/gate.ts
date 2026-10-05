/** POST /api/tasks/:id/gate — the client approves the build or returns it with a reason. */
import type { APIRoute } from 'astro';
import { requireSession } from '../../../../server/auth';
import { handle, json, readBody, sameOrigin } from '../../../../server/http';
import { getTask, saveTask } from '../../../../server/repo';
import { kickIfDue } from '../../../../server/runner';
import { decideGate } from '../../../../server/tasks';

export const prerender = false;

export const POST: APIRoute = ({ params, request, cookies }) =>
  handle(async () => {
    sameOrigin(request);
    const { workspace } = await requireSession(cookies);
    const task = await getTask(workspace.id, params.id ?? '');
    const body = await readBody(request);
    decideGate(task, body.decision, body.note);
    await saveTask(task);
    kickIfDue(new URL(request.url).origin, task);
    return json(task);
  });
