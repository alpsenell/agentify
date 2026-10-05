/**
 * GET /api/github/repos — repositories the workspace's GitHub App
 * installation can see (RepoOption[], sorted, capped). When capped, the
 * response carries `X-Agentify-Truncated: 1`.
 */
import type { APIRoute } from 'astro';
import { requireSession } from '../../../server/auth';
import { listRepos } from '../../../server/github';
import { handle, json } from '../../../server/http';

export const prerender = false;

export const GET: APIRoute = ({ cookies }) =>
  handle(async () => {
    const { workspace } = await requireSession(cookies);
    const { repos, truncated } = await listRepos(workspace);
    const res = json(repos);
    if (truncated) res.headers.set('X-Agentify-Truncated', '1');
    return res;
  });
