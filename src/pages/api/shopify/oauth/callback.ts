/**
 * GET /api/shopify/oauth/callback — where Shopify sends the merchant back
 * after they approve the Agentify app. Checks, in order: the HMAC Shopify put
 * on the query, the shop hostname, the signed state (not expired, same shop,
 * nonce matching the cookie), and that the signed-in owner is in the
 * workspace the state was issued for. Then exchanges the code for an
 * expiring offline token, connects the store through the same path as a
 * pasted token, and returns to Settings with ?shopify=connected or
 * ?shopify_error=<code>.
 */
import type { APIRoute } from 'astro';
import { HttpError, requireSession, verifyValue } from '../../../../server/auth';
import { completeOAuth, oauthApp } from '../../../../server/shopify';
import { decodeState, isShopHostname, verifyCallbackHmac } from '../../../../server/shopify/oauth';
import { OAUTH_COOKIE, oauthCookieOptions, settingsRedirect } from '../../../../server/shopify/oauth-http';

export const prerender = false;

/** Server error codes the app has a specific message for; anything else is reported as "failed". */
const KNOWN = new Set(['shopify_missing_scopes', 'shopify_domain_taken', 'store_not_found', 'shopify_token_rejected', 'shopify_store_unavailable', 'shopify_store_not_found']);

export const GET: APIRoute = async ({ url, cookies }) => {
  const params = url.searchParams;
  const nonce = cookies.get(OAUTH_COOKIE)?.value;
  cookies.delete(OAUTH_COOKIE, { path: oauthCookieOptions().path });
  let storeId = '';
  const fail = (code: string) => settingsRedirect({ shopify_error: code, store: storeId });

  try {
    const app = oauthApp();
    if (!app) return fail('not_configured');
    if (!verifyCallbackHmac(params, app.clientSecret)) return fail('hmac');
    const shop = params.get('shop');
    if (!isShopHostname(shop)) return fail('invalid_shop');
    const state = decodeState(params.get('state'), verifyValue);
    if (!state) return fail('expired');
    storeId = state.storeId;
    if (!nonce || nonce !== state.nonce || state.shop !== shop.toLowerCase()) return fail('state');
    const code = params.get('code');
    if (!code) return fail('denied');

    const { user, workspace } = await requireSession(cookies);
    if (workspace.id !== state.workspaceId) return fail('state');
    if (user.role !== 'owner') return fail('owner_only');

    await completeOAuth(workspace, state.storeId, shop, code);
    return settingsRedirect({ shopify: 'connected', store: state.storeId });
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.status === 401) return fail('signed_out');
      if (KNOWN.has(err.code)) return fail(err.code);
    }
    console.error('shopify oauth callback failed', err instanceof Error ? err.message : err);
    return fail('failed');
  }
};
