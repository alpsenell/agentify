/**
 * The low-level half of the GitHub connection: the GitHub App's JWT,
 * installation access tokens (cached in memory until shortly before they
 * expire), a small REST client with retries, and input validation. No imports
 * from the rest of the server, so it runs on its own under node:test.
 *
 * Tokens are never put in error messages or logs. Every request goes to
 * api.github.com or github.com; nothing user-supplied becomes a host.
 */
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';

/** Pinned REST API version. None of its breaking changes touch the endpoints used here. */
export const API_VERSION = '2026-03-10';
export const API = 'https://api.github.com';

export type GitHubErrorCode =
  | 'not_configured' | 'invalid_input'
  | 'installation_missing' | 'installation_suspended'
  | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'unprocessable'
  | 'rate_limited' | 'github_error' | 'network_error';

export class GitHubError extends Error {
  // Plain fields rather than parameter properties, so Node can run this file with type stripping.
  code: GitHubErrorCode;
  status: number;
  /** GitHub's own message, when it sent one. */
  detail: string;
  /** From X-Accepted-GitHub-Permissions on a refused call, e.g. "contents=write". */
  permissions: string;
  constructor(code: GitHubErrorCode, message: string, status = 0, detail = '', permissions = '') {
    super(message);
    this.code = code;
    this.status = status;
    this.detail = detail;
    this.permissions = permissions;
  }
}

/* ── the app's JWT ─────────────────────────────────────────────────── */

/**
 * The private key as configured: real newlines or literal "\n", optionally
 * wrapped in quotes, or the whole PEM base64-encoded. PKCS#1 ("BEGIN RSA
 * PRIVATE KEY", what GitHub downloads) and PKCS#8 ("BEGIN PRIVATE KEY") both work.
 */
export function normalisePem(raw: string): string {
  let pem = raw.trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim();
  if (!pem.includes('-----BEGIN')) {
    const decoded = Buffer.from(pem, 'base64').toString('utf8');
    if (decoded.includes('-----BEGIN')) pem = decoded.trim();
  }
  return `${pem}\n`;
}

const keys = new Map<string, KeyObject>();

function privateKey(raw: string): KeyObject {
  const hit = keys.get(raw);
  if (hit) return hit;
  let key: KeyObject;
  try {
    key = createPrivateKey(normalisePem(raw));
  } catch {
    throw new GitHubError('not_configured', 'GITHUB_APP_PRIVATE_KEY is not a valid PEM private key. Paste the .pem file GitHub generated for the app (newlines may be written as \\n).');
  }
  if (key.asymmetricKeyType !== 'rsa') throw new GitHubError('not_configured', 'GITHUB_APP_PRIVATE_KEY must be the RSA key GitHub generated for the app.');
  keys.set(raw, key);
  return key;
}

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * An RS256 JWT that authenticates as the app, valid for 9 minutes. `iat` is
 * backdated 60 s against clock drift, as GitHub recommends; `exp` may be at
 * most 10 minutes ahead.
 */
export function appJwt(appId: string, rawKey: string, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const input = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ iat: seconds - 60, exp: seconds + 540, iss: appId })}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey(rawKey)).toString('base64url')}`;
}

/* ── HTTP with retries ─────────────────────────────────────────────── */

export interface HttpOpts {
  fetchImpl?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}

const MAX_ATTEMPTS = 4;
/** The longest single wait for a rate limit; beyond it the call fails rather than holding a function open. */
const MAX_WAIT_MS = 10_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Sent {
  status: number;
  headers: Headers;
  body: unknown;
}

/** How long to wait before retrying a 403/429, or null when it is not a rate limit (or too long to wait). */
function rateLimitWait(res: Response, body: unknown, now: number): number | null | 'too_long' {
  const message = typeof (body as { message?: unknown })?.message === 'string' ? (body as { message: string }).message : '';
  const retryAfter = Number(res.headers.get('retry-after'));
  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  const limited = res.status === 429 || /rate limit/i.test(message) || remaining === '0';
  if (!limited) return null;
  let ms: number;
  if (Number.isFinite(retryAfter) && retryAfter > 0) ms = retryAfter * 1000;
  else if (remaining === '0' && Number.isFinite(reset) && reset > 0) ms = Math.max(1000, reset * 1000 - now);
  else ms = 60_000; // GitHub: with no hint, wait at least a minute.
  return ms > MAX_WAIT_MS ? 'too_long' : ms;
}

/** GitHub's message plus any validation errors ("Validation Failed" alone says little). */
function errorDetail(body: unknown): string {
  const b = body as { message?: unknown; errors?: unknown } | null;
  const message = typeof b?.message === 'string' ? b.message : '';
  const errors = Array.isArray(b?.errors)
    ? b.errors.map((e: unknown) => (typeof e === 'string' ? e : typeof (e as { message?: unknown })?.message === 'string' ? (e as { message: string }).message : '')).filter(Boolean)
    : [];
  return [message, ...errors].filter(Boolean).join(': ');
}

/** One request with retries on network errors, 5xx and short rate limits. Throws GitHubError for anything else that is not 2xx. */
async function send(url: string, init: RequestInit, opts: HttpOpts): Promise<Sent> {
  const doFetch = opts.fetchImpl ?? fetch;
  const wait = opts.wait ?? sleep;
  const now = opts.now ?? Date.now;
  let lastError: GitHubError | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      lastError = new GitHubError('network_error', `Could not reach GitHub: ${(err as Error).name === 'TimeoutError' ? 'the request timed out' : 'network error'}.`);
      if (attempt < MAX_ATTEMPTS) { await wait(500 * attempt); continue; }
      throw lastError;
    }
    const text = await res.text().catch(() => '');
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (res.ok) return { status: res.status, headers: res.headers, body };

    const detail = errorDetail(body);
    if (res.status === 403 || res.status === 429) {
      const ms = rateLimitWait(res, body, now());
      if (ms !== null) {
        lastError = new GitHubError('rate_limited', 'GitHub is rate limiting Agentify right now. Try again in a few minutes.', res.status, detail);
        if (ms !== 'too_long' && attempt < MAX_ATTEMPTS) { await wait(ms); continue; }
        throw lastError;
      }
    }
    if (res.status >= 500) {
      lastError = new GitHubError('github_error', `GitHub returned an error (${res.status}). Try again shortly.`, res.status, detail);
      if (attempt < MAX_ATTEMPTS) { await wait(1000 * attempt); continue; }
      throw lastError;
    }
    const permissions = res.headers.get('x-accepted-github-permissions') ?? '';
    const code: GitHubErrorCode = res.status === 401 ? 'unauthorized' : res.status === 403 ? 'forbidden' : res.status === 404 ? 'not_found'
      : res.status === 409 ? 'conflict' : res.status === 422 ? 'unprocessable' : 'github_error';
    throw new GitHubError(code, detail ? `GitHub refused the request (${res.status}): ${detail.slice(0, 300)}` : `GitHub refused the request (${res.status}).`, res.status, detail, permissions);
  }
  throw lastError ?? new GitHubError('github_error', 'GitHub request failed.');
}

const baseHeaders = (token: string): Record<string, string> => ({
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': API_VERSION,
  'User-Agent': 'Agentify',
  Authorization: `Bearer ${token}`,
});

/* ── installation access tokens ────────────────────────────────────── */

export interface AppCredentials {
  appId: string;
  privateKey: string;
}

/** Refresh a cached token when less than this is left (tokens live an hour). */
const REFRESH_MARGIN_MS = 5 * 60_000;

export interface TokenCache {
  get(installationId: number): Promise<string>;
  drop(installationId: number): void;
}

/** Installation tokens, minted with the app JWT and cached per installation in memory. */
export function tokenCache(creds: AppCredentials, opts: HttpOpts = {}): TokenCache {
  const now = opts.now ?? Date.now;
  const cache = new Map<number, { token: string; expiresAt: number }>();
  const inflight = new Map<number, Promise<string>>();

  async function mint(installationId: number): Promise<string> {
    let sent: Sent;
    try {
      sent = await send(`${API}/app/installations/${installationId}/access_tokens`, {
        method: 'POST', headers: baseHeaders(appJwt(creds.appId, creds.privateKey, now())),
      }, opts);
    } catch (err) {
      if (err instanceof GitHubError && err.code === 'not_found') {
        throw new GitHubError('installation_missing', 'The Agentify GitHub App is no longer installed on this account. Reinstall it from Settings → GitHub.', 404);
      }
      if (err instanceof GitHubError && err.code === 'forbidden' && /suspend/i.test(err.detail)) {
        throw new GitHubError('installation_suspended', 'The Agentify GitHub App installation is suspended. Unsuspend it in the account’s GitHub settings (Applications → Installed GitHub Apps).', 403);
      }
      if (err instanceof GitHubError && err.code === 'unauthorized') {
        throw new GitHubError('not_configured', 'GitHub rejected the app’s credentials. Check GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY.', 401);
      }
      throw err;
    }
    const body = sent.body as { token?: string; expires_at?: string };
    if (!body?.token) throw new GitHubError('github_error', 'GitHub did not return an installation token.');
    const expiresAt = Date.parse(body.expires_at ?? '') || now() + 60 * 60_000;
    cache.set(installationId, { token: body.token, expiresAt });
    return body.token;
  }

  return {
    async get(installationId) {
      const hit = cache.get(installationId);
      if (hit && hit.expiresAt - now() > REFRESH_MARGIN_MS) return hit.token;
      const pending = inflight.get(installationId);
      if (pending) return pending;
      const promise = mint(installationId).finally(() => inflight.delete(installationId));
      inflight.set(installationId, promise);
      return promise;
    },
    drop(installationId) {
      cache.delete(installationId);
    },
  };
}

/* ── REST client ───────────────────────────────────────────────────── */

export interface Gh {
  /** `path` starts with "/" and is relative to api.github.com. Throws GitHubError. */
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

/** A client that acts as one installation. A 401 (token revoked early) drops the cached token and retries once. */
export function installationClient(tokens: TokenCache, installationId: number, opts: HttpOpts = {}): Gh {
  return {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      for (let attempt = 1; ; attempt++) {
        const token = await tokens.get(installationId);
        try {
          const sent = await send(`${API}${path}`, {
            method,
            headers: { ...baseHeaders(token), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: body === undefined ? undefined : JSON.stringify(body),
          }, opts);
          return sent.body as T;
        } catch (err) {
          if (err instanceof GitHubError && err.code === 'unauthorized' && attempt === 1) { tokens.drop(installationId); continue; }
          throw err;
        }
      }
    },
  };
}

/** A client that acts as a user (a user access token from the install's OAuth step). */
export function userClient(token: string, opts: HttpOpts = {}): Gh {
  return {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      const sent = await send(`${API}${path}`, {
        method,
        headers: { ...baseHeaders(token), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }, opts);
      return sent.body as T;
    },
  };
}

/** null for a 404, the response otherwise. */
export async function orNull<T>(call: Promise<T>): Promise<T | null> {
  try {
    return await call;
  } catch (err) {
    if (err instanceof GitHubError && err.code === 'not_found') return null;
    throw err;
  }
}

/* ── the install's OAuth step ──────────────────────────────────────── */

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

/** Exchange the `code` GitHub sent to the callback for a user access token. */
export async function exchangeCode(creds: OAuthCredentials, code: string, opts: HttpOpts = {}): Promise<string> {
  const sent = await send('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Agentify' },
    body: JSON.stringify({ client_id: creds.clientId, client_secret: creds.clientSecret, code }),
  }, opts);
  // Errors come back as 200 with an `error` field.
  const body = sent.body as { access_token?: string; error?: string; error_description?: string };
  if (!body?.access_token) {
    throw new GitHubError(body?.error === 'incorrect_client_credentials' ? 'not_configured' : 'unauthorized',
      body?.error === 'incorrect_client_credentials'
        ? 'GitHub rejected the app’s client ID or secret. Check GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET.'
        : `GitHub did not accept the authorization code (${body?.error ?? 'no token returned'}). Start the installation again.`);
  }
  return body.access_token;
}

/** Revoke a user access token once it has served its purpose. Best effort: a failure is not an error for the caller. */
export async function revokeUserToken(creds: OAuthCredentials, token: string, opts: HttpOpts = {}): Promise<void> {
  try {
    await send(`${API}/applications/${encodeURIComponent(creds.clientId)}/token`, {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': API_VERSION, 'User-Agent': 'Agentify', 'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64')}`,
      },
      body: JSON.stringify({ access_token: token }),
    }, { ...opts, wait: async () => {} });
  } catch {
    // The token expires on its own; nothing else holds it.
  }
}

export interface UserInstallation { id: number; account: { login: string } | null; suspended_at?: string | null }

/**
 * The installation as seen by the user who holds `userToken`, or null when
 * that user cannot access it. GET /user/installations lists only this app's
 * installations that the user can access, so this is the proof that the
 * person completing the install may connect it.
 */
export async function findUserInstallation(userToken: string, installationId: number, opts: HttpOpts = {}): Promise<UserInstallation | null> {
  const gh = userClient(userToken, opts);
  for (let page = 1; page <= 10; page++) {
    const data = await gh.request<{ installations: UserInstallation[] }>('GET', `/user/installations?per_page=100&page=${page}`);
    const found = data.installations.find((i) => i.id === installationId);
    if (found) return found;
    if (data.installations.length < 100) break;
  }
  return null;
}

/* ── install state ─────────────────────────────────────────────────── */

export interface InstallState { w: string; u: string; e: number; n: string }

type Signer = { sign: (value: string) => string; verify: (value: string, mac: string) => boolean };

/** A signed, expiring state for the install URL, bound to a workspace and user. */
export function makeState(s: Signer, workspaceId: string, userId: string, nonce: string, expiresAt: number): string {
  const payload = Buffer.from(JSON.stringify({ w: workspaceId, u: userId, e: expiresAt, n: nonce } satisfies InstallState)).toString('base64url');
  return `${payload}.${s.sign(`github-install:${payload}`)}`;
}

/** The state if its signature holds and it has not expired, else null. */
export function readState(s: Signer, state: string | null | undefined, now = Date.now()): InstallState | null {
  if (!state) return null;
  const [payload, mac, extra] = state.split('.');
  if (!payload || !mac || extra !== undefined || !s.verify(`github-install:${payload}`, mac)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as InstallState;
    return typeof parsed.w === 'string' && typeof parsed.u === 'string' && parsed.e > now ? parsed : null;
  } catch {
    return null;
  }
}

/* ── input validation ──────────────────────────────────────────────── */

const bad = (message: string) => new GitHubError('invalid_input', message);

/** A user or organisation login. */
export function validateOwner(input: unknown): string {
  const value = typeof input === 'string' ? input.trim() : '';
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value)) throw bad('Choose a repository owner (a GitHub user or organisation name).');
  return value;
}

/** A repository name. */
export function validateRepoName(input: unknown): string {
  const value = typeof input === 'string' ? input.trim() : '';
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(value) || value === '.' || value === '..') throw bad('Choose a repository.');
  return value;
}

/** A branch name, following git's ref-name rules closely enough to refuse anything odd. */
export function validateBranch(input: unknown): string {
  const value = typeof input === 'string' ? input.trim() : '';
  const fail = () => { throw bad(`"${value.slice(0, 80)}" is not a valid branch name.`); };
  if (!value) throw bad('Choose a base branch.');
  if (value.length > 200 || /[\s~^:?*[\\\x00-\x1f\x7f]/.test(value) || value.includes('..') || value.includes('@{') || value.includes('//')) fail();
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.') || value.endsWith('.lock') || value === '@') fail();
  if (value.split('/').some((s) => s.startsWith('.'))) fail();
  return value;
}

/**
 * The folder holding the theme, normalised: no leading/trailing "/", "" for
 * the repository root. Refuses "." and ".." segments, odd characters, and
 * hidden folders (".github" would need the workflows permission to write).
 */
export function normaliseThemeRoot(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input !== 'string') throw bad('The theme folder must be text, e.g. "theme" or "" for the repository root.');
  const value = input.trim().replace(/^\.\/+/, '').replace(/^\/+|\/+$/g, '');
  if (value === '' || value === '.') return '';
  const fail = (why: string) => { throw bad(`Theme folder "${value.slice(0, 120)}" ${why}`); };
  if (value.length > 200) fail('is too long.');
  if (!/^[A-Za-z0-9._\-/ ]+$/.test(value)) fail('may only contain letters, digits, spaces, ".", "_", "-" and "/".');
  const segments = value.split('/');
  if (segments.some((s) => !s || s === '.' || s === '..')) fail('may not contain empty, "." or ".." segments.');
  if (segments.some((s) => s.startsWith('.'))) fail('may not be inside a hidden folder.');
  if (segments.some((s) => s !== s.trim())) fail('may not have segments that start or end with a space.');
  return segments.join('/');
}

/** Encode each segment of a path for a URL, keeping the slashes. */
export const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** A theme-relative path placed under the theme root. */
export const repoPath = (themeRoot: string, themePath: string) => (themeRoot ? `${themeRoot}/${themePath}` : themePath);
