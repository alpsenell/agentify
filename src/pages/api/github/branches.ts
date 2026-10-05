/** GET /api/github/branches?owner=&repo= — branch names of a repository, the default branch first. */
import type { APIRoute } from 'astro';
import { requireSession } from '../../../server/auth';
import { listRepoBranches } from '../../../server/github';
import { handle, json } from '../../../server/http';

export const prerender = false;

export const GET: APIRoute = ({ request, cookies }) =>
  handle(async () => {
    const { workspace } = await requireSession(cookies);
    const q = new URL(request.url).searchParams;
    return json(await listRepoBranches(workspace, q.get('owner'), q.get('repo')));
  });
