/** GET, PATCH and DELETE /api/tasks/:id — one request. */
import type { APIRoute } from 'astro';
import { requireSession } from '../../../../server/auth';
import { handle, json, readBody, sameOrigin } from '../../../../server/http';
import { deleteTask, getTask, saveTask } from '../../../../server/repo';
import { kickIfDue } from '../../../../server/runner';
import { editTask } from '../../../../server/tasks';

export const prerender = false;

export const GET: APIRoute = ({ params, cookies }) =>
  handle(async () => {
    const { workspace } = await requireSession(cookies);
    return json(await getTask(workspace.id, params.id ?? ''));
  });

export const PATCH: APIRoute = ({ params, request, cookies }) =>
  handle(async () => {
    sameOrigin(request);
    const { workspace } = await requireSession(cookies);
    const task = await getTask(workspace.id, params.id ?? '');
    editTask(task, await readBody(request));
    await saveTask(task);
    // Resuming a paused request starts the team again.
    kickIfDue(new URL(request.url).origin, task);
    return json(task);
  });

export const DELETE: APIRoute = ({ params, request, cookies }) =>
  handle(async () => {
    sameOrigin(request);
    const { workspace } = await requireSession(cookies);
    await deleteTask(workspace.id, params.id ?? '');
    return json(null, 204);
  });
