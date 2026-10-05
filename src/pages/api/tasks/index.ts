/** GET /api/tasks — the workspace's requests. POST — open one from the client's first message. */
import type { APIRoute } from 'astro';
import { resolveAttachments } from '../../../server/attachments';
import { requireSession } from '../../../server/auth';
import { handle, json, readBody, sameOrigin } from '../../../server/http';
import { createTask, listTasks } from '../../../server/repo';
import { kickIfDue } from '../../../server/runner';

export const prerender = false;

export const GET: APIRoute = ({ cookies }) =>
  handle(async () => {
    const { workspace } = await requireSession(cookies);
    return json(await listTasks(workspace.id));
  });

export const POST: APIRoute = ({ request, cookies }) =>
  handle(async () => {
    sameOrigin(request);
    const { workspace } = await requireSession(cookies);
    const body = await readBody(request);
    const attachments = await resolveAttachments(workspace.id, body.attachments);
    const task = await createTask(workspace, typeof body.message === 'string' ? body.message : '', body.storeId, attachments);
    kickIfDue(new URL(request.url).origin, task);
    return json(task, 201);
  });
