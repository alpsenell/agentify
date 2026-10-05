/** PATCH /api/workspace — rename the workspace or edit the notes every agent reads. */
import type { APIRoute } from 'astro';
import { HttpError, requireSession } from '../../server/auth';
import { handle, json, readBody, sameOrigin } from '../../server/http';
import { getWorkspace, saveWorkspace } from '../../server/repo';

export const prerender = false;

export const PATCH: APIRoute = ({ request, cookies }) =>
  handle(async () => {
    sameOrigin(request);
    const session = await requireSession(cookies);
    // Re-read so a store connection made a moment ago is not overwritten.
    const workspace = (await getWorkspace(session.workspace.id)) ?? session.workspace;
    const body = await readBody(request);
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
      if (!name) throw new HttpError(400, 'invalid_name', 'The workspace name cannot be empty.');
      workspace.name = name;
    }
    if (body.notes !== undefined) {
      if (typeof body.notes !== 'string') throw new HttpError(400, 'bad_request', '"notes" must be text.');
      workspace.notes = body.notes.slice(0, 8000);
    }
    await saveWorkspace(workspace);
    return json(workspace);
  });
