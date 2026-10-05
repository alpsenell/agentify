/**
 * GET /api/github/install — send the owner to GitHub to install the Agentify
 * GitHub App, with a signed, expiring state bound to their workspace and
 * account. GitHub comes back to /api/github/callback.
 */
import type { APIRoute } from 'astro';
import { HttpError, requireSession } from '../../../server/auth';
import { githubConfigured, installUrl } from '../../../server/github';
import { errorBody } from '../../../server/http';

export const prerender = false;

const back = (request: Request, outcome: string) => Response.redirect(new URL(`/dashboard/settings?github=${outcome}#github`, request.url), 302);

export const GET: APIRoute = async ({ request, cookies }) => {
  try {
    const { user } = await requireSession(cookies);
    if (user.role !== 'owner') return back(request, 'not_owner');
    if (!githubConfigured()) return back(request, 'not_configured');
    return Response.redirect(installUrl(user), 302);
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) return Response.redirect(new URL('/dashboard', request.url), 302);
    errorBody(err);
    return back(request, 'error');
  }
};
