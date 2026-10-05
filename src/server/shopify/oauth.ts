/**
 * The pure half of the Shopify OAuth install (authorization code grant, for an
 * app that runs outside the Shopify admin): the authorize URL, the callback
 * HMAC check, the signed state, and the token endpoint calls (code exchange
 * and refresh of expiring offline tokens). No imports from the rest of the
 * server, so it can be exercised on its own (see admin.test.mjs).
 *
 * Follows https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
 * New public apps must request expiring offline tokens (`expiring=1`): the
 * access token lives an hour and comes with a rotating refresh token (90 days).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ShopifyError, normaliseDomain } from './admin.ts';

/** Shopify's own check for the `shop` it sends back, anchored at both ends. */
const SHOP_HOSTNAME = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

export const isShopHostname = (value: unknown): value is string => typeof value === 'string' && SHOP_HOSTNAME.test(value);

/** The Shopify authorization page for one shop. `shop` must already be normalised. */
export function authorizeUrl(input: { shop: string; clientId: string; scopes: string; redirectUri: string; state: string }): string {
  const shop = normaliseDomain(input.shop);
  const query = new URLSearchParams({
    client_id: input.clientId, scope: input.scopes, redirect_uri: input.redirectUri, state: input.state,
  });
  return `https://${shop}/admin/oauth/authorize?${query}`;
}

/**
 * Verify the `hmac` Shopify puts on the callback query: drop `hmac`, sort the
 * remaining (decoded) parameters by name, join as `k=v&k=v`, HMAC-SHA256 with
 * the app's client secret, hex, constant-time compare.
 */
export function verifyCallbackHmac(params: URLSearchParams, clientSecret: string): boolean {
  const given = params.get('hmac');
  if (!given || !clientSecret) return false;
  const message = [...params]
    .filter(([key]) => key !== 'hmac')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const digest = Buffer.from(createHmac('sha256', clientSecret).update(message).digest('hex'));
  const provided = Buffer.from(given);
  return digest.length === provided.length && timingSafeEqual(digest, provided);
}

/* ── state ─────────────────────────────────────────────────────────── */

/** What the state binds: which workspace and store the install is for, the shop, a nonce, and an expiry. */
export interface OAuthState {
  workspaceId: string;
  storeId: string;
  shop: string;
  nonce: string;
  /** ms timestamp after which the state is refused. */
  exp: number;
}

export const STATE_TTL_MS = 10 * 60_000;

/** `base64url(json).mac`, where `sign` is an HMAC with the server secret. */
export function encodeState(state: OAuthState, sign: (value: string) => string): string {
  const body = Buffer.from(JSON.stringify(state)).toString('base64url');
  return `${body}.${sign(body)}`;
}

/** The state, or null when it is malformed, forged or expired. */
export function decodeState(raw: unknown, verify: (value: string, mac: string) => boolean, now = Date.now()): OAuthState | null {
  if (typeof raw !== 'string' || raw.length > 2000) return null;
  const dot = raw.indexOf('.');
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  if (!mac || !verify(body, mac)) return null;
  let parsed: Partial<OAuthState>;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<OAuthState>;
  } catch {
    return null;
  }
  const { workspaceId, storeId, shop, nonce, exp } = parsed;
  if (typeof workspaceId !== 'string' || typeof storeId !== 'string' || typeof shop !== 'string' || typeof nonce !== 'string' || typeof exp !== 'number') return null;
  if (exp < now) return null;
  return { workspaceId, storeId, shop, nonce, exp };
}

/* ── token endpoint ────────────────────────────────────────────────── */

/** What Agentify keeps for an OAuth install. Expiry fields are null for a non-expiring token. */
export interface TokenSet {
  accessToken: string;
  scopes: string[];
  /** ms timestamp, or null when the token does not expire. */
  expiresAt: number | null;
  refreshToken: string | null;
  refreshExpiresAt: number | null;
}

interface TokenResponse {
  access_token?: unknown;
  scope?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  refresh_token_expires_in?: unknown;
}

const at = (seconds: unknown, now: number) => {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? now + n * 1000 : null;
};

export function parseTokenResponse(body: TokenResponse, now = Date.now()): TokenSet {
  const token = typeof body.access_token === 'string' ? body.access_token.trim() : '';
  if (!token || /\s/.test(token)) throw new ShopifyError('shopify_error', 'Shopify did not return an access token.');
  const refresh = typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : null;
  return {
    accessToken: token,
    scopes: typeof body.scope === 'string' ? body.scope.split(',').map((s) => s.trim()).filter(Boolean).sort() : [],
    // Without a refresh token an expiry would only strand the store; treat it as non-expiring.
    expiresAt: refresh ? at(body.expires_in, now) : null,
    refreshToken: refresh,
    refreshExpiresAt: refresh ? at(body.refresh_token_expires_in, now) : null,
  };
}

interface TokenCallOpts { fetchImpl?: typeof fetch; now?: number }

/** "refresh token dead" (send the merchant back through OAuth) vs any other failure. */
export class TokenError extends ShopifyError {
  terminal: boolean;
  constructor(message: string, terminal: boolean, status = 0) {
    super(terminal ? 'token_rejected' : 'shopify_error', message, status);
    this.terminal = terminal;
  }
}

async function tokenCall(shop: string, form: Record<string, string>, opts: TokenCallOpts): Promise<TokenSet> {
  const domain = normaliseDomain(shop);
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(`https://${domain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new TokenError(`Could not reach ${domain} to get an access token. Try again.`, false);
  }
  // Shopify answers a dead/expired/revoked refresh token or a used code with 401 (sometimes 400 invalid_grant/invalid_request).
  if (res.status === 401) throw new TokenError('Shopify no longer accepts this store’s authorization. Connect the store again.', true, 401);
  if (res.status === 400) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const terminal = body?.error === 'invalid_grant' || body?.error === 'invalid_request';
    throw new TokenError(terminal ? 'Shopify refused the authorization (it may have expired or already been used). Connect the store again.'
      : 'Shopify refused the token request.', terminal, 400);
  }
  if (res.status === 404 || (res.status >= 300 && res.status < 400)) {
    throw new ShopifyError('store_not_found', `No Shopify store answered at ${domain}. Check the .myshopify.com address.`, res.status);
  }
  if (!res.ok) throw new TokenError(`Shopify’s token endpoint returned ${res.status}. Try again shortly.`, false, res.status);
  const body = (await res.json().catch(() => null)) as TokenResponse | null;
  if (!body) throw new TokenError('Shopify’s token endpoint returned a response that is not JSON.', false);
  return parseTokenResponse(body, opts.now);
}

/** Exchange the callback's code for an expiring offline access token. */
export function exchangeCode(shop: string, code: string, app: { clientId: string; clientSecret: string }, opts: TokenCallOpts = {}): Promise<TokenSet> {
  return tokenCall(shop, { client_id: app.clientId, client_secret: app.clientSecret, code, expiring: '1' }, opts);
}

/** Trade the refresh token for a new access token and a new refresh token. */
export function refreshTokens(shop: string, refreshToken: string, app: { clientId: string; clientSecret: string }, opts: TokenCallOpts = {}): Promise<TokenSet> {
  return tokenCall(shop, { client_id: app.clientId, client_secret: app.clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken }, opts);
}
