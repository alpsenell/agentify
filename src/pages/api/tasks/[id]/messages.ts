/** POST /api/tasks/:id/messages — the client writes in the thread. */
import type { APIRoute } from 'astro';
import { resolveAttachments } from '../../../../server/attachments';
import { requireSession } from '../../../../server/auth';
import { handle, json, readBody, sameOrigin } from '../../../../server/http';
import { getTask, saveTask } from '../../../../server/repo';
import { kickIfDue } from '../../../../server/runner';
import { addClientMessage } from '../../../../server/tasks';

export const prerender = false;

export const POST: APIRoute = ({ params, request, cookies }) =>
  handle(async () => {
    sameOrigin(request);
    const { workspace } = await requireSession(cookies);
    const task = await getTask(workspace.id, params.id ?? '');
    const body = await readBody(request);
    addClientMessage(task, body.text, await resolveAttachments(workspace.id, body.attachments));
    await saveTask(task);
    kickIfDue(new URL(request.url).origin, task);
    return json(task);
  });
