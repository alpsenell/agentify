/**
 * The low-level half of the store connection: input validation (store
 * domains, tokens, theme paths) and a small Admin GraphQL client with
 * throttle handling. No imports from the rest of the server, so it can be
 * exercised on its own (see admin.test.mjs).
 *
 * The store domain becomes a fetch target, so it is the SSRF surface: only
 * `<handle>.myshopify.com` ever leaves normaliseDomain, and requests refuse
 * redirects.
 */

/** Pinned Admin API version. Bump deliberately, after re-validating the operations in index.ts. */
export const API_VERSION = '2026-07';

/** A failure talking to Shopify, with a machine code the caller maps to a message or HTTP status. */
export type ShopifyErrorCode =
  | 'invalid_domain' | 'invalid_token' | 'invalid_path'
  | 'token_rejected' | 'access_denied' | 'store_not_found' | 'store_unavailable'
  | 'throttled' | 'shopify_error' | 'network_error';

export class ShopifyError extends Error {
  // Plain fields rather than parameter properties, so Node can run this file with type stripping.
  code: ShopifyErrorCode;
  status: number;
  constructor(code: ShopifyErrorCode, message: string, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/* ── input validation ──────────────────────────────────────────────── */

const HANDLE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Turn what a merchant pastes into `<handle>.myshopify.com`, or throw.
 * Accepts "my-store", "my-store.myshopify.com", "https://my-store.myshopify.com/admin"
 * and the admin URL "https://admin.shopify.com/store/my-store/...".
 */
export function normaliseDomain(input: unknown): string {
  const fail = (msg = 'Enter your store’s .myshopify.com address, e.g. my-store.myshopify.com.') => {
    throw new ShopifyError('invalid_domain', msg);
  };
  if (typeof input !== 'string') return fail();
  let value = input.trim().toLowerCase();
  if (!value || value.length > 200) return fail();

  value = value.replace(/^https?:\/\//, '');
  const admin = /^admin\.shopify\.com\/store\/([^/?#]+)/.exec(value);
  if (admin) value = `${admin[1]}.myshopify.com`;
  value = value.replace(/[/?#].*$/, '');

  if (!value.includes('.')) value = `${value}.myshopify.com`;
  const match = /^([^.]+)\.myshopify\.com$/.exec(value);
  if (!match) {
    return fail('Use the store’s .myshopify.com address, not a custom domain. You can find it in Shopify admin under Settings → Domains.');
  }
  if (!HANDLE.test(match[1]!) || match[1]!.endsWith('-')) return fail();
  return value;
}

/** The Admin API access token of a custom app, e.g. "shpat_…". */
export function normaliseToken(input: unknown): string {
  const value = typeof input === 'string' ? input.trim() : '';
  if (/^shp[a-z]{2}_[A-Za-z0-9]{16,200}$/.test(value)) return value;
  // A common mistake: pasting the app's API key or secret instead of the token.
  const hint = /^[a-f0-9]{32}$/.test(value)
    ? ' That looks like the API key or secret key; use the Admin API access token instead.'
    : '';
  throw new ShopifyError('invalid_token',
    `Paste the Admin API access token from your custom app (it starts with "shpat_"). It is shown once, after you install the app, under API credentials.${hint}`);
}

/** The folders a theme may contain. */
export const THEME_FOLDERS = ['assets', 'blocks', 'config', 'layout', 'locales', 'sections', 'snippets', 'templates'] as const;

const PATH_CHARS = /^[A-Za-z0-9._\-/]+$/;

function checkThemePath(path: string, label: string): void {
  const bad = (why: string) => { throw new ShopifyError('invalid_path', `${label} "${path.slice(0, 120)}" ${why}`); };
  if (path.length > 200) bad('is too long.');
  if (!PATH_CHARS.test(path)) bad('may only contain letters, digits, ".", "_", "-" and "/".');
  if (path.startsWith('/')) bad('must be theme-relative (no leading "/").');
  const segments = path.split('/');
  if (segments.some((s) => s === '..' || s === '.')) bad('may not contain "." or ".." segments.');
  if (!(THEME_FOLDERS as readonly string[]).includes(segments[0]!)) {
    bad(`must start with one of: ${THEME_FOLDERS.map((f) => `${f}/`).join(', ')}.`);
  }
}

/** A path to one theme file, e.g. "sections/size-guide.liquid". */
export function validateThemePath(input: unknown): string {
  const path = typeof input === 'string' ? input.trim() : '';
  if (!path) throw new ShopifyError('invalid_path', 'A theme file path is required, e.g. "sections/header.liquid".');
  checkThemePath(path, 'Theme path');
  const segments = path.split('/');
  if (segments.length < 2 || segments.some((s) => !s)) {
    throw new ShopifyError('invalid_path', `Theme path "${path}" must name a file inside a folder, e.g. "sections/header.liquid".`);
  }
  if (!/\.[a-z0-9]+$/i.test(segments.at(-1)!)) {
    throw new ShopifyError('invalid_path', `Theme path "${path}" must end in a file extension, e.g. ".liquid".`);
  }
  return path;
}

/** A folder or filename prefix, e.g. "sections/", "templates/customers" or "snippets/card-". Empty means the whole theme. */
export function validateThemePrefix(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input !== 'string') throw new ShopifyError('invalid_path', 'The theme prefix must be text, e.g. "sections/".');
  const prefix = input.trim();
  if (!prefix) return '';
  checkThemePath(prefix, 'Theme prefix');
  if (prefix.includes('//')) throw new ShopifyError('invalid_path', `Theme prefix "${prefix}" may not contain "//".`);
  // A bare folder name means the folder, not every file starting with those letters.
  return (THEME_FOLDERS as readonly string[]).includes(prefix) ? `${prefix}/` : prefix;
}

/** "gid://shopify/OnlineStoreTheme/123" → "123". */
export const numericId = (gid: string) => gid.split('/').pop() ?? gid;

/* ── Admin GraphQL client ──────────────────────────────────────────── */

interface GraphqlError {
  message: string;
  extensions?: { code?: string };
}

interface GraphqlBody<T> {
  data?: T;
  errors?: GraphqlError[] | string;
  extensions?: { cost?: { requestedQueryCost?: number; throttleStatus?: { currentlyAvailable?: number; restoreRate?: number } } };
}

export interface AdminClient {
  domain: string;
  /** Run one operation. Throws ShopifyError; never includes the token in messages. */
  query<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

const MAX_ATTEMPTS = 4;
const MAX_WAIT_MS = 8_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A client bound to one store. `fetchImpl` and `wait` are injectable for tests.
 * Retries throttling (HTTP 429 and GraphQL THROTTLED) and 5xx, waiting as long
 * as the throttle status says it takes for the bucket to refill.
 */
export function adminClient(
  domain: string,
  token: string,
  opts: { fetchImpl?: typeof fetch; wait?: (ms: number) => Promise<void> } = {},
): AdminClient {
  const safeDomain = normaliseDomain(domain);
  const url = `https://${safeDomain}/admin/api/${API_VERSION}/graphql.json`;
  const doFetch = opts.fetchImpl ?? fetch;
  const wait = opts.wait ?? sleep;

  async function query<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    let lastError: ShopifyError | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': token },
          body: JSON.stringify({ query, variables }),
          // A redirect would mean the domain is not a live store; never follow it elsewhere.
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        lastError = new ShopifyError('network_error', `Could not reach ${safeDomain}: ${(err as Error).name === 'TimeoutError' ? 'the request timed out' : 'network error'}.`);
        if (attempt < MAX_ATTEMPTS) { await wait(500 * attempt); continue; }
        throw lastError;
      }

      if (res.status === 429 || res.status >= 500) {
        lastError = res.status === 429
          ? new ShopifyError('throttled', 'Shopify is rate limiting requests to this store. Try again in a minute.', 429)
          : new ShopifyError('shopify_error', `Shopify returned an error (${res.status}). Try again shortly.`, res.status);
        if (attempt < MAX_ATTEMPTS) {
          const retryAfter = Number(res.headers.get('retry-after'));
          await wait(Math.min(MAX_WAIT_MS, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * attempt));
          continue;
        }
        throw lastError;
      }
      if (res.status === 401) throw new ShopifyError('token_rejected', 'Shopify rejected the access token. Check that you copied the Admin API access token of an installed custom app, and that the app has not been uninstalled.', 401);
      if (res.status === 403) throw new ShopifyError('access_denied', 'The access token is not allowed to do this. Check the app’s Admin API scopes.', 403);
      if (res.status === 404 || (res.status >= 300 && res.status < 400)) throw new ShopifyError('store_not_found', `No Shopify store answered at ${safeDomain}. Check the .myshopify.com address.`, res.status);
      if (res.status === 402 || res.status === 423) throw new ShopifyError('store_unavailable', `The store ${safeDomain} is frozen or locked (${res.status}). It needs to be active in Shopify before Agentify can use it.`, res.status);
      if (!res.ok) throw new ShopifyError('shopify_error', `Shopify returned an unexpected status (${res.status}).`, res.status);

      const body = (await res.json().catch(() => null)) as GraphqlBody<T> | null;
      if (!body) throw new ShopifyError('shopify_error', 'Shopify returned a response that is not JSON.');

      const errors = typeof body.errors === 'string' ? [{ message: body.errors }] : body.errors ?? [];
      if (errors.some((e) => e.extensions?.code === 'THROTTLED')) {
        lastError = new ShopifyError('throttled', 'Shopify is rate limiting requests to this store. Try again in a minute.');
        if (attempt < MAX_ATTEMPTS) {
          const cost = body.extensions?.cost;
          const need = (cost?.requestedQueryCost ?? 100) - (cost?.throttleStatus?.currentlyAvailable ?? 0);
          const rate = cost?.throttleStatus?.restoreRate || 50;
          await wait(Math.min(MAX_WAIT_MS, Math.max(500, Math.ceil((need / rate) * 1000))));
          continue;
        }
        throw lastError;
      }
      if (errors.some((e) => e.extensions?.code === 'ACCESS_DENIED')) {
        throw new ShopifyError('access_denied', errors.map((e) => e.message).join(' '));
      }
      if (errors.length && !body.data) {
        throw new ShopifyError('shopify_error', `Shopify returned an error: ${errors.map((e) => e.message).join(' ').slice(0, 500)}`);
      }
      return body.data as T;
    }
    throw lastError ?? new ShopifyError('shopify_error', 'Shopify request failed.');
  }

  return { domain: safeDomain, query };
}
