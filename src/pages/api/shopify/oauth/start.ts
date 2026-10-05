/**
 * GET /api/shopify/oauth/start?store=<id>&shop=<domain> — begin the Agentify
 * Shopify app install for one store (owner only). Redirects the browser to
 * the shop's authorization page with a signed, expiring state that binds the
 * workspace, store, shop and a nonce; the nonce also goes in a short-lived
 * HttpOnly cookie that the callback compares. Failures come back to Settings
 * as ?shopify_error=<code>.
 */
import { randomBytes } from 'node:crypto';
import type { APIRoute } from 'astro';
import { HttpError, requireSession, signValue } from '../../../../server/auth';
import { normaliseDomain, oauthApp, oauthRedirectUri } from '../../../../server/shopify';
import { STATE_TTL_MS, authorizeUrl, encodeState } from '../../../../server/shopify/oauth';
import { OAUTH_COOKIE, oauthCookieOptions, settingsRedirect } from '../../../../server/shopify/oauth-http';

export const prerender = false;

export const GET: APIRoute = async ({ url, cookies, request }) => {
  const storeId = url.searchParams.get('store') ?? '';
  const fail = (code: string) => settingsRedirect({ shopify_error: code, store: storeId });
  try {
    const app = oauthApp();
    if (!app) return fail('not_configured');
    const { user, workspace } = await requireSession(cookies);
    if (user.role !== 'owner') return fail('owner_only');
    if (!workspace.stores.some((s) => s.id === storeId)) return fail('store_not_found');
    let shop: string;
    try {
      shop = normaliseDomain(url.searchParams.get('shop'));
    } catch {
      return fail('invalid_shop');
    }

    const nonce = randomBytes(16).toString('hex');
    const state = encodeState({ workspaceId: workspace.id, storeId, shop, nonce, exp: Date.now() + STATE_TTL_MS }, signValue);
    cookies.set(OAUTH_COOKIE, nonce, oauthCookieOptions());
    return new Response(null, {
      status: 302,
      headers: {
        Location: authorizeUrl({ shop, clientId: app.clientId, scopes: app.scopes, redirectUri: oauthRedirectUri(request.url), state }),
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) return settingsRedirect({}, '/dashboard');
    console.error('shopify oauth start failed', err instanceof Error ? err.message : err);
    return fail('failed');
  }
};
