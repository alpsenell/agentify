/**
 * GET /api/github/callback — the GitHub App's Callback URL. With "Request
 * user authorization (OAuth) during installation" on, GitHub sends the
 * installer here with installation_id, setup_action, state and code. The
 * installation is saved only once GitHub confirms, through the code, that
 * this person can access it (see completeInstall). Always redirects back to
 * /dashboard/settings?github=<outcome>.
 */
import type { APIRoute } from 'astro';
import { HttpError, requireSession } from '../../../server/auth';
import { completeInstall } from '../../../server/github';
import { errorBody } from '../../../server/http';

export const prerender = false;

const back = (request: Request, outcome: string) => Response.redirect(new URL(`/dashboard/settings?github=${outcome}#github`, request.url), 302);

export const GET: APIRoute = async ({ request, cookies }) => {
  const url = new URL(request.url);
  const q = url.searchParams;
  try {
    const { user, workspace } = await requireSession(cookies);
    const outcome = await completeInstall(user, workspace, {
      installationId: q.get('installation_id'), setupAction: q.get('setup_action'), state: q.get('state'), code: q.get('code'),
    });
    return back(request, outcome);
  } catch (err) {
    // Signed out in this browser: the state is bound to a session, so the flow has to start again after signing in.
    if (err instanceof HttpError && err.status === 401) return back(request, 'signed_out');
    errorBody(err);
    return back(request, 'error');
  }
};
