/** GET /api/me — the signed-in user, their workspace, and whether the agents can run. */
import type { APIRoute } from 'astro';
import type { Me } from '../../agency/types';
import { billingConfigured, getUsage } from '../../server/billing';
import { githubConfigured } from '../../server/github';
import { emailConfigured } from '../../server/notify';
import { oauthConfigured } from '../../server/shopify';
import { llmReady } from '../../server/agents/llm';
import { requireSession } from '../../server/auth';
import { handle, json } from '../../server/http';

export const prerender = false;

export const GET: APIRoute = ({ cookies }) =>
  handle(async () => {
    const { user, workspace } = await requireSession(cookies);
    const me: Me = {
      user, workspace, usage: await getUsage(workspace), llmReady: llmReady(),
      capabilities: {
        llm: llmReady(), shopifyOAuth: oauthConfigured(), github: githubConfigured(),
        billing: billingConfigured(), email: emailConfigured(),
      },
    };
    return json(me);
  });

/* PATCH /api/me {name?, notify?} — the signed-in user changes their own name or email preference. */
import { HttpError as MeError, updateUser } from '../../server/auth';
import { readBody, sameOrigin } from '../../server/http';

export const PATCH: APIRoute = ({ request, cookies }) =>
  handle(async () => {
    sameOrigin(request);
    const { user } = await requireSession(cookies);
    const body = await readBody(request);
    const patch: { name?: string; notify?: boolean } = {};
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
      if (!name) throw new MeError(400, 'invalid_name', 'Your name cannot be empty.');
      patch.name = name;
    }
    if (body.notify !== undefined) {
      if (typeof body.notify !== 'boolean') throw new MeError(400, 'bad_request', '"notify" must be true or false.');
      patch.notify = body.notify;
    }
    return json(await updateUser(user.id, patch));
  });
