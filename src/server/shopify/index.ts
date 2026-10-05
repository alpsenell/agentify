/**
 * The store connection: everything the agents and the app do against a
 * client's Shopify store goes through this module. A workspace has several
 * stores; every call takes the workspace and the store it is about.
 *
 * A store is connected one of two ways: the Agentify Shopify app's OAuth
 * install (authorization code grant, expiring offline token refreshed here;
 * see oauth.ts), or a pasted Admin API token from a custom app the merchant
 * created in their Shopify admin before that was retired. Either way the
 * token is stored encrypted under its own key per store, never on the
 * Workspace (which is sent to the browser). Reads go to the live (MAIN)
 * theme; the only write, deployPreview, goes to an unpublished copy of it and
 * never to the live theme. Publishing stays a human action in Shopify admin.
 *
 * Operations are written against Admin GraphQL API_VERSION (admin.ts).
 */
import type { Deploy, ShopifyConnection, Store, Task, Workspace } from '../../agency/types';
import { HttpError, decryptSecret, encryptSecret } from '../auth';
import { getWorkspace, saveWorkspace } from '../repo';
import { getStore } from '../storage';
import {
  type AdminClient, ShopifyError, adminClient, normaliseDomain, normaliseToken, numericId,
  validateThemePath, validateThemePrefix,
} from './admin';
import { type TokenSet, TokenError, exchangeCode, refreshTokens } from './oauth';

export { API_VERSION, ShopifyError, normaliseDomain } from './admin';

/** Scopes Agentify needs: reading the theme for context, writing to deploy previews. */
export const REQUIRED_SCOPES = ['read_themes', 'write_themes'] as const;

/** What the OAuth install asks for unless SHOPIFY_SCOPES says otherwise. */
export const DEFAULT_OAUTH_SCOPES = 'read_themes,write_themes,read_products';

const env = (name: string): string | undefined => process.env[name] ?? (import.meta.env?.[name] as string | undefined);

/** The Agentify Shopify app's credentials, or null when the server is not configured for OAuth. */
export function oauthApp(): { clientId: string; clientSecret: string; scopes: string } | null {
  const clientId = env('SHOPIFY_API_KEY')?.trim();
  const clientSecret = env('SHOPIFY_API_SECRET')?.trim();
  if (!clientId || !clientSecret) return null;
  const scopes = (env('SHOPIFY_SCOPES') ?? DEFAULT_OAUTH_SCOPES).split(',').map((s) => s.trim()).filter(Boolean).join(',');
  return { clientId, clientSecret, scopes: scopes || DEFAULT_OAUTH_SCOPES };
}

export const oauthConfigured = (): boolean => oauthApp() !== null;

/**
 * Where Shopify sends the merchant back. It must exactly match a redirect URL
 * configured on the app in the Dev Dashboard, so production should pin it with
 * SHOPIFY_REDIRECT_URI; otherwise it follows the host the request came in on.
 */
export function oauthRedirectUri(requestUrl: string): string {
  return env('SHOPIFY_REDIRECT_URI')?.trim() || `${new URL(requestUrl).origin}/api/shopify/oauth/callback`;
}

const notConnected = () => new HttpError(409, 'shopify_not_connected', 'This store is not connected to Shopify.');

const tokenKey = (workspaceId: string, storeId: string) => `shopify:token:${workspaceId}:${storeId}`;
const refreshLockKey = (workspaceId: string, storeId: string) => `shopify:refresh-lock:${workspaceId}:${storeId}`;
const previewPrefix = (workspaceId: string, storeId: string) => `shopify:preview:${workspaceId}:${storeId}:`;
const previewKey = (workspaceId: string, storeId: string, taskId: string) => `${previewPrefix(workspaceId, storeId)}${taskId}`;

interface StoredToken {
  domain: string;
  via: ShopifyConnection['via'];
  /** The access token, encrypted. */
  sealed: string;
  /** The refresh token, encrypted; null for a pasted or non-expiring token. */
  refresh?: string | null;
  expiresAt?: number | null;
  refreshExpiresAt?: number | null;
}
interface StoredPreview { domain: string; themeId: string }

/** Map a ShopifyError onto the HTTP error the routes return. */
function toHttp(err: unknown): unknown {
  if (!(err instanceof ShopifyError)) return err;
  const status = {
    invalid_domain: 400, invalid_token: 400, invalid_path: 400,
    token_rejected: 400, access_denied: 403, store_not_found: 400, store_unavailable: 409,
    throttled: 429, shopify_error: 502, network_error: 502,
  }[err.code];
  return new HttpError(status, `shopify_${err.code}`, err.message);
}

/** write_X implies read_X in Shopify's scope model. */
function hasScope(scopes: string[], scope: string): boolean {
  return scopes.includes(scope) || (scope.startsWith('read_') && scopes.includes(`write_${scope.slice(5)}`));
}

/** Which of REQUIRED_SCOPES a connection lacks. Empty when Agentify can read and deploy. */
export function missingScopes(scopes: string[]): string[] {
  return REQUIRED_SCOPES.filter((s) => !hasScope(scopes, s));
}

/** Where the merchant can open a theme in the theme editor. */
export function themeEditorUrl(domain: string, themeId: string): string {
  return `https://${normaliseDomain(domain)}/admin/themes/${numericId(themeId)}/editor`;
}

/** Where the merchant can see their themes and publish one. */
export function themesAdminUrl(domain: string): string {
  return `https://${normaliseDomain(domain)}/admin/themes`;
}

const scopesHelp = (missing: string[], via: ShopifyConnection['via']) => via === 'oauth'
  ? `Connect the store again from Agentify’s settings and approve ${missing.join(' and ')} when Shopify asks.`
  : `In Shopify admin open Settings → Apps and sales channels → Develop apps → your app → Configuration → Admin API integration, ` +
    `enable ${missing.join(' and ')}, save, then install/update the app so the scopes are granted. ` +
    `Then reconnect the store here (paste the token again, or the new one if Shopify issued one) so Agentify sees the new scopes.`;

/* ── client for a connected store ──────────────────────────────────── */

const REFRESH_EARLY_MS = 2 * 60_000;
const LOCK_STALE_MS = 30_000;
const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const reconnect = (message = 'Shopify no longer accepts this store’s saved authorization. Connect the store again in Settings.') =>
  new HttpError(409, 'shopify_reconnect', message);

function unseal(sealed: string): string {
  try {
    return decryptSecret(sealed);
  } catch {
    // SESSION_SECRET changed since the token was saved.
    throw reconnect('The saved store credentials can no longer be read. Disconnect and reconnect the store.');
  }
}

/**
 * Refresh an expiring OAuth token. Refresh tokens rotate, so only one refresh
 * runs per store at a time (a lock key in storage, since serverless instances
 * share nothing else); a caller that finds the lock held waits for the other
 * refresh and re-reads the result.
 */
async function refreshStored(workspaceId: string, storeId: string, stored: StoredToken): Promise<StoredToken> {
  const app = oauthApp();
  if (!app || !stored.refresh) throw reconnect();
  const store = getStore();
  const key = tokenKey(workspaceId, storeId);
  const lock = refreshLockKey(workspaceId, storeId);
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await store.setIfAbsent(lock, Date.now())) {
      try {
        // Someone may have refreshed between our read and the lock.
        const current = (await store.get<StoredToken>(key)) ?? stored;
        if (current.sealed !== stored.sealed && (current.expiresAt ?? Infinity) > Date.now() + REFRESH_EARLY_MS) return current;
        if (!current.refresh) throw reconnect();
        let tokens: TokenSet;
        try {
          tokens = await refreshTokens(current.domain, unseal(current.refresh), app);
        } catch (err) {
          if (err instanceof TokenError && err.terminal) throw reconnect();
          throw err;
        }
        const next: StoredToken = { ...current, ...sealTokens(tokens) };
        await store.set<StoredToken>(key, next);
        return next;
      } finally {
        await store.delete(lock);
      }
    }
    const heldSince = await store.get<number>(lock);
    if (heldSince !== null && Date.now() - heldSince > LOCK_STALE_MS) { await store.delete(lock); continue; }
    await sleepMs(500);
    const current = await store.get<StoredToken>(key);
    if (current && current.sealed !== stored.sealed) return current;
  }
  throw new HttpError(503, 'shopify_busy', 'Shopify authorization is being refreshed. Try again in a moment.');
}

function sealTokens(tokens: TokenSet): Pick<StoredToken, 'sealed' | 'refresh' | 'expiresAt' | 'refreshExpiresAt'> {
  return {
    sealed: encryptSecret(tokens.accessToken),
    refresh: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
    expiresAt: tokens.expiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt,
  };
}

/**
 * A client for the store's saved token, refreshing an expiring token shortly
 * before it lapses and once more if Shopify rejects it mid-flight.
 */
async function clientFor(workspace: Workspace, store: Store): Promise<AdminClient | null> {
  if (!store.shopify) return null;
  const kv = getStore();
  let stored = await kv.get<StoredToken>(tokenKey(workspace.id, store.id));
  if (!stored || stored.domain !== store.shopify.domain) return null;
  if (stored.refresh && stored.expiresAt && Date.now() > stored.expiresAt - REFRESH_EARLY_MS) {
    stored = await refreshStored(workspace.id, store.id, stored);
  }
  let client = adminClient(stored.domain, unseal(stored.sealed));
  const query = async <T>(q: string, variables?: Record<string, unknown>): Promise<T> => {
    try {
      return await client.query<T>(q, variables);
    } catch (err) {
      if (!(err instanceof ShopifyError && err.code === 'token_rejected' && stored!.refresh)) throw err;
      stored = await refreshStored(workspace.id, store.id, stored!);
      client = adminClient(stored.domain, unseal(stored.sealed));
      return client.query<T>(q, variables);
    }
  };
  return { domain: client.domain, query };
}

async function requireClient(workspace: Workspace, store: Store): Promise<AdminClient> {
  const client = await clientFor(workspace, store);
  if (!client) throw notConnected();
  return client;
}

/* ── connect / disconnect ──────────────────────────────────────────── */

interface ConnectData {
  shop: { name: string; myshopifyDomain: string };
  currentAppInstallation: { accessScopes: { handle: string }[] };
}

const CONNECT_QUERY = `query AgentifyConnect {
  shop { name myshopifyDomain }
  currentAppInstallation { accessScopes { handle } }
}`;

/** The workspace as stored now, and the store in it, or a 404. */
async function freshStore(workspace: Workspace, storeId: string): Promise<{ fresh: Workspace; target: Store }> {
  const fresh = (await getWorkspace(workspace.id)) ?? workspace;
  const target = fresh.stores.find((s) => s.id === storeId);
  if (!target) throw new HttpError(404, 'store_not_found', 'That store does not exist in this workspace.');
  return { fresh, target };
}

/** Copy the saved workspace's stores onto the caller's object, so it sees the change too. */
function sync(workspace: Workspace, fresh: Workspace): Workspace {
  if (workspace !== fresh) workspace.stores = fresh.stores;
  return fresh;
}

/**
 * The one path every connection goes through: check the token against the
 * store, refuse a shop another store in the workspace already uses, save the
 * token encrypted and record the public connection on the store.
 *
 * Without read_themes the connection is refused. Without write_themes it is
 * made read-only: agents can read the store, deployPreview fails with a
 * message saying which scope to add. Callers can check missingScopes(conn.scopes).
 */
async function saveConnection(
  workspace: Workspace, storeId: string, domain: string, tokens: TokenSet, via: ShopifyConnection['via'],
): Promise<ShopifyConnection> {
  const data = await adminClient(domain, tokens.accessToken).query<ConnectData>(CONNECT_QUERY);

  const scopes = data.currentAppInstallation.accessScopes.map((s) => s.handle).sort();
  if (!hasScope(scopes, 'read_themes')) {
    const missing = missingScopes(scopes);
    throw new HttpError(400, 'shopify_missing_scopes',
      `The ${via === 'oauth' ? 'authorization' : 'app’s token'} is missing the ${missing.join(' and ')} scope${missing.length > 1 ? 's' : ''}. ${scopesHelp(missing, via)}`);
  }

  // Prefer the store's own canonical address if it reports one we accept.
  let canonical = domain;
  try { canonical = normaliseDomain(data.shop.myshopifyDomain); } catch { /* keep what was entered */ }

  const { fresh, target } = await freshStore(workspace, storeId);
  const other = fresh.stores.find((s) => s.id !== storeId && s.shopify?.domain === canonical);
  if (other) {
    throw new HttpError(409, 'shopify_domain_taken', `${canonical} is already connected to the store “${other.label}” in this workspace. Disconnect it there first.`);
  }

  const connection: ShopifyConnection = { domain: canonical, shopName: data.shop.name, connectedAt: Date.now(), scopes, via };
  const kv = getStore();
  // A different shop on the same store starts with no preview themes to reuse.
  if (target.shopify && target.shopify.domain !== canonical) await deletePreviews(workspace.id, storeId);
  await kv.set<StoredToken>(tokenKey(workspace.id, storeId), { domain: canonical, via, ...sealTokens(tokens) });
  target.shopify = connection;
  await saveWorkspace(fresh);
  sync(workspace, fresh);
  contextCache.delete(storeId);
  return connection;
}

/** Connect a store with a pasted Admin API token from a custom app. */
export async function connectStore(workspace: Workspace, store: Store, input: { domain: unknown; token: unknown }): Promise<ShopifyConnection> {
  try {
    const domain = normaliseDomain(input.domain);
    const token = normaliseToken(input.token);
    const tokens: TokenSet = { accessToken: token, scopes: [], expiresAt: null, refreshToken: null, refreshExpiresAt: null };
    const connection = await saveConnection(workspace, store.id, domain, tokens, 'token');
    store.shopify = connection;
    return connection;
  } catch (err) {
    throw toHttp(err);
  }
}

/** Finish an OAuth install: trade the callback's code for an offline token and connect the store with it. */
export async function completeOAuth(workspace: Workspace, storeId: string, shop: string, code: string): Promise<ShopifyConnection> {
  const app = oauthApp();
  if (!app) throw new HttpError(409, 'shopify_oauth_not_configured', 'Connecting with Shopify is not set up on this server.');
  try {
    const domain = normaliseDomain(shop);
    const tokens = await exchangeCode(domain, code, app);
    return await saveConnection(workspace, storeId, domain, tokens, 'oauth');
  } catch (err) {
    throw toHttp(err);
  }
}

async function deletePreviews(workspaceId: string, storeId: string): Promise<void> {
  const kv = getStore();
  for (const key of await kv.keys(previewPrefix(workspaceId, storeId))) await kv.delete(key);
}

/** Forget the store's Shopify connection and delete its saved token and preview-theme bookkeeping. */
export async function disconnectStore(workspace: Workspace, store: Store): Promise<void> {
  const kv = getStore();
  await kv.delete(tokenKey(workspace.id, store.id));
  await kv.delete(refreshLockKey(workspace.id, store.id));
  await deletePreviews(workspace.id, store.id);
  const fresh = (await getWorkspace(workspace.id)) ?? workspace;
  const target = fresh.stores.find((s) => s.id === store.id);
  if (target) {
    target.shopify = null;
    await saveWorkspace(fresh);
    sync(workspace, fresh);
  }
  store.shopify = null;
  contextCache.delete(store.id);
}

/**
 * Move a token saved by the single-store version (keyed by workspace) onto a
 * store. For the lead's workspace migration: call once per legacy workspace
 * after creating the store from its old `shopify` field.
 */
export async function adoptLegacyToken(workspaceId: string, storeId: string): Promise<boolean> {
  const kv = getStore();
  const legacy = await kv.get<StoredToken>(`shopify:token:${workspaceId}`);
  if (!legacy) return false;
  await kv.set<StoredToken>(tokenKey(workspaceId, storeId), { ...legacy, via: legacy.via ?? 'token' });
  await kv.delete(`shopify:token:${workspaceId}`);
  return true;
}

/* ── themes ────────────────────────────────────────────────────────── */

type ThemeRole = 'MAIN' | 'UNPUBLISHED' | 'DEVELOPMENT' | 'DEMO' | 'LOCKED' | 'ARCHIVED' | string;

interface ThemeNode { id: string; name: string; role: ThemeRole; processing: boolean; processingFailed?: boolean; updatedAt?: string }

const MAIN_THEME_QUERY = `query AgentifyMainTheme {
  themes(first: 1, roles: [MAIN]) { nodes { id name role } }
}`;

async function mainTheme(client: AdminClient): Promise<ThemeNode> {
  const data = await client.query<{ themes: { nodes: ThemeNode[] } }>(MAIN_THEME_QUERY);
  const theme = data.themes.nodes[0];
  if (!theme) throw new HttpError(409, 'shopify_no_live_theme', 'The store has no published theme. Publish a theme in Shopify admin first.');
  return theme;
}

const FILES_QUERY = `query AgentifyThemeFiles($id: ID!, $filenames: [String!], $first: Int!, $after: String) {
  theme(id: $id) {
    id
    files(filenames: $filenames, first: $first, after: $after) {
      nodes { filename size contentType }
      pageInfo { hasNextPage endCursor }
      userErrors { code filename }
    }
  }
}`;

interface FilesData {
  theme: {
    files: {
      nodes: { filename: string; size: string; contentType: string }[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      userErrors: { code: string; filename: string }[];
    } | null;
  } | null;
}

const LIST_CAP = 2500;

/**
 * Paths of files in the live theme, optionally limited to a prefix such as
 * "sections/". If the theme has more than LIST_CAP matching files, the last
 * entry is a note saying the list was cut, not a path.
 */
export async function listThemeFiles(workspace: Workspace, store: Store, prefix?: string): Promise<string[]> {
  try {
    const safePrefix = validateThemePrefix(prefix);
    const client = await requireClient(workspace, store);
    const theme = await mainTheme(client);
    const paths: string[] = [];
    let after: string | null = null;
    for (;;) {
      const data: FilesData = await client.query<FilesData>(FILES_QUERY, {
        id: theme.id, filenames: safePrefix ? [`${safePrefix}*`] : null, first: 500, after,
      });
      const files = data.theme?.files;
      if (!files) break;
      paths.push(...files.nodes.map((n) => n.filename));
      if (!files.pageInfo.hasNextPage || !files.pageInfo.endCursor) break;
      if (paths.length >= LIST_CAP) {
        paths.sort();
        paths.push(`(list cut at ${paths.length} files; pass a narrower prefix such as "sections/" to see the rest)`);
        return paths;
      }
      after = files.pageInfo.endCursor;
    }
    return paths.sort();
  } catch (err) {
    throw toHttp(err);
  }
}

const FILE_QUERY = `query AgentifyThemeFile($id: ID!, $filenames: [String!]!) {
  theme(id: $id) {
    files(filenames: $filenames, first: 1) {
      nodes {
        filename
        size
        contentType
        body {
          ... on OnlineStoreThemeFileBodyText { content }
          ... on OnlineStoreThemeFileBodyBase64 { contentBase64 }
          ... on OnlineStoreThemeFileBodyUrl { url }
        }
      }
      userErrors { code filename }
    }
  }
}`;

interface FileData {
  theme: {
    files: {
      nodes: { filename: string; size: string; contentType: string; body: { content?: string; contentBase64?: string; url?: string } }[];
      userErrors: { code: string; filename: string }[];
    } | null;
  } | null;
}

/** Characters of one file returned to an agent; longer files are cut with a note. */
export const READ_CAP = 60_000;

/**
 * The text content of one file in the live theme. Files over READ_CAP
 * characters are cut and end with a note saying so; binary files return a
 * one-line description instead of their bytes.
 */
export async function readThemeFile(workspace: Workspace, store: Store, path: string): Promise<string> {
  try {
    const safePath = validateThemePath(path);
    const client = await requireClient(workspace, store);
    const theme = await mainTheme(client);
    const content = await readFileFrom(client, theme.id, safePath);
    if (content === null) {
      throw new HttpError(404, 'theme_file_not_found', `The live theme "${theme.name}" has no file "${safePath}". Use listThemeFiles to see what exists.`);
    }
    return content;
  } catch (err) {
    throw toHttp(err);
  }
}

async function readFileFrom(client: AdminClient, themeId: string, path: string, cap = READ_CAP): Promise<string | null> {
  const data = await client.query<FileData>(FILE_QUERY, { id: themeId, filenames: [path] });
  const node = data.theme?.files?.nodes.find((n) => n.filename === path);
  if (!node) return null;
  const { content } = node.body;
  if (typeof content !== 'string') {
    return `[${path} is a binary file (${node.contentType}, ${node.size} bytes); its content is not shown.]`;
  }
  if (content.length <= cap) return content;
  return `${content.slice(0, cap)}\n\n[truncated: showing the first ${cap.toLocaleString('en-US')} of ${content.length.toLocaleString('en-US')} characters of ${path}]`;
}

/* ── store context ─────────────────────────────────────────────────── */

const SHOP_QUERY = `query AgentifyShop {
  shop {
    name
    myshopifyDomain
    currencyCode
    plan { publicDisplayName shopifyPlus partnerDevelopment }
    primaryDomain { host url }
  }
  themes(first: 25) { nodes { id name role processing updatedAt } }
}`;

interface ShopData {
  shop: {
    name: string; myshopifyDomain: string; currencyCode: string;
    plan: { publicDisplayName: string; shopifyPlus: boolean; partnerDevelopment: boolean };
    primaryDomain: { host: string; url: string } | null;
  };
  themes: { nodes: ThemeNode[] };
}

const COUNTS_QUERY = `query AgentifyCounts {
  productsCount { count precision }
  collectionsCount { count precision }
}`;

const MARKETS_QUERY = `query AgentifyMarkets {
  markets(first: 20) { nodes { name handle status } }
}`;

const LOCALES_QUERY = `query AgentifyLocales {
  shopLocales { locale name primary published }
}`;

const THEME_SHAPE_QUERY = `query AgentifyThemeShape($id: ID!) {
  theme(id: $id) {
    jsonTemplates: files(filenames: ["templates/*.json"], first: 1) { nodes { filename } }
    themeBlocks: files(filenames: ["blocks/*.liquid"], first: 1) { nodes { filename } }
    sections: files(filenames: ["sections/*.liquid"], first: 250) { nodes { filename } }
    settingsSchema: files(filenames: ["config/settings_schema.json"], first: 1) {
      nodes { body { ... on OnlineStoreThemeFileBodyText { content } } }
    }
  }
}`;

interface ThemeShapeData {
  theme: {
    jsonTemplates: { nodes: { filename: string }[] } | null;
    themeBlocks: { nodes: { filename: string }[] } | null;
    sections: { nodes: { filename: string }[] } | null;
    settingsSchema: { nodes: { body: { content?: string } }[] } | null;
  } | null;
}

const CONTEXT_TTL_MS = 2 * 60_000;
/** Keyed by store id. */
const contextCache = new Map<string, { key: string; at: number; text: string }>();

/** An optional part of the summary: on a missing scope or error, a one-line note instead of a failure. */
async function optional<T>(run: () => Promise<T>, scope: string): Promise<{ ok: true; value: T } | { ok: false; note: string }> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    if (err instanceof ShopifyError && err.code === 'access_denied') return { ok: false, note: `unavailable (the app lacks ${scope})` };
    return { ok: false, note: 'unavailable (Shopify returned an error)' };
  }
}

const countText = (c: { count: number; precision: string }) => `${c.precision === 'EXACT' ? '' : 'at least '}${c.count.toLocaleString('en-US')}`;

/**
 * A compact Markdown summary of the store for an agent to read: shop name,
 * plan, currency, markets, the live theme (name, id, whether it is OS 2.0),
 * other themes, and anything else that changes how a feature should be built.
 */
export async function storeContext(workspace: Workspace, store: Store): Promise<string> {
  try {
    const client = await requireClient(workspace, store);
    const conn = store.shopify!;
    const cacheKey = `${conn.domain}:${conn.connectedAt}`;
    const cached = contextCache.get(store.id);
    if (cached && cached.key === cacheKey && Date.now() - cached.at < CONTEXT_TTL_MS) return cached.text;

    const { shop, themes } = await client.query<ShopData>(SHOP_QUERY);
    const live = themes.nodes.find((t) => t.role === 'MAIN');

    const [counts, markets, locales, shape] = await Promise.all([
      optional(() => client.query<{ productsCount: { count: number; precision: string }; collectionsCount: { count: number; precision: string } }>(COUNTS_QUERY), 'read_products'),
      optional(() => client.query<{ markets: { nodes: { name: string; handle: string; status: string }[] } }>(MARKETS_QUERY), 'read_markets'),
      optional(() => client.query<{ shopLocales: { locale: string; name: string; primary: boolean; published: boolean }[] }>(LOCALES_QUERY), 'read_locales'),
      live ? optional(() => client.query<ThemeShapeData>(THEME_SHAPE_QUERY, { id: live.id }), 'read_themes') : Promise.resolve(null),
    ]);

    const lines: string[] = [`## Store: ${shop.name} (${store.label}, ${store.env})`];
    lines.push(`- Address: ${shop.myshopifyDomain}${shop.primaryDomain && shop.primaryDomain.host !== shop.myshopifyDomain ? ` (customers see ${shop.primaryDomain.host})` : ''}`);
    lines.push(`- Plan: ${shop.plan.publicDisplayName}${shop.plan.shopifyPlus ? ' — Shopify Plus (checkout extensibility, Functions with custom apps, B2B available)' : ' — not Plus'}${shop.plan.partnerDevelopment ? ' (development store)' : ''}`);
    lines.push(`- Currency: ${shop.currencyCode}`);
    lines.push(counts.ok
      ? `- Catalogue: ${countText(counts.value.productsCount)} products, ${countText(counts.value.collectionsCount)} collections`
      : `- Catalogue: ${counts.note}`);
    if (markets.ok) {
      const active = markets.value.markets.nodes.filter((m) => m.status === 'ACTIVE');
      lines.push(`- Markets: ${active.length ? active.map((m) => m.name).join(', ') : 'none active'}`);
    } else {
      lines.push(`- Markets: ${markets.note}`);
    }
    if (locales.ok) {
      const published = locales.value.shopLocales.filter((l) => l.published);
      const primary = locales.value.shopLocales.find((l) => l.primary);
      lines.push(`- Languages: ${published.map((l) => `${l.name} (${l.locale})${l.primary ? ' primary' : ''}`).join(', ') || primary?.locale || 'unknown'}${published.length > 1 ? ' — theme copy must go through locale files, not hard-coded strings' : ''}`);
    } else {
      lines.push(`- Languages: ${locales.note}`);
    }

    lines.push('', '## Live theme');
    if (!live) {
      lines.push('No published theme.');
    } else {
      lines.push(`- ${live.name} (id ${numericId(live.id)})`);
      if (shape?.ok && shape.value.theme) {
        const t = shape.value.theme;
        const os2 = (t.jsonTemplates?.nodes.length ?? 0) > 0;
        const schemaText = t.settingsSchema?.nodes[0]?.body.content;
        const info = schemaText ? themeInfo(schemaText) : null;
        if (info) lines.push(`- Based on: ${info}`);
        lines.push(os2
          ? '- Online Store 2.0: yes (JSON templates; new sections can be added in the theme editor and support app blocks)'
          : '- Online Store 2.0: no (Liquid templates; new sections must be included from template files or added to a legacy theme manually)');
        if ((t.themeBlocks?.nodes.length ?? 0) > 0) lines.push('- Theme blocks: yes (has a blocks/ folder; reusable theme blocks are available)');
        const sectionNames = (t.sections?.nodes ?? []).map((n) => n.filename.replace(/^sections\/|\.liquid$/g, ''));
        if (sectionNames.length) lines.push(`- Sections (${sectionNames.length}${sectionNames.length >= 250 ? '+' : ''}): ${sectionNames.slice(0, 60).join(', ')}${sectionNames.length > 60 ? ', …' : ''}`);
      } else if (shape && !shape.ok) {
        lines.push(`- Theme structure: ${shape.note}`);
      }
    }

    const others = themes.nodes.filter((t) => t.role !== 'MAIN');
    if (others.length) {
      lines.push('', `## Other themes (${others.length} of max 20 on the store)`);
      for (const t of others.slice(0, 20)) lines.push(`- ${t.name} (id ${numericId(t.id)}, ${t.role.toLowerCase()})`);
    }

    const missing = missingScopes(conn.scopes);
    lines.push('', '## Agentify access');
    lines.push(missing.length
      ? `- Read-only: the app lacks ${missing.join(', ')}. Work can be built but not deployed to a preview theme until the client adds it.`
      : '- Can read the live theme and deploy approved work to an unpublished preview theme. Never writes to the live theme.');

    const text = lines.join('\n');
    contextCache.set(store.id, { key: cacheKey, at: Date.now(), text });
    return text;
  } catch (err) {
    throw toHttp(err);
  }
}

/** "Dawn 15.0.0" from config/settings_schema.json, which starts with a theme_info entry. */
function themeInfo(schema: string): string | null {
  try {
    const parsed = JSON.parse(schema) as { name?: string; theme_name?: string; theme_version?: string }[];
    const info = Array.isArray(parsed) ? parsed.find((e) => e?.name === 'theme_info') : null;
    if (!info?.theme_name) return null;
    return `${info.theme_name}${info.theme_version ? ` ${info.theme_version}` : ''}`.slice(0, 80);
  } catch {
    return null;
  }
}

/* ── deploy to a preview theme ─────────────────────────────────────── */

const SCOPES_QUERY = `query AgentifyScopes {
  currentAppInstallation { accessScopes { handle } }
}`;

const THEMES_QUERY = `query AgentifyThemes {
  themes(first: 25) { nodes { id name role processing } }
}`;

const THEME_QUERY = `query AgentifyTheme($id: ID!) {
  theme(id: $id) { id name role processing processingFailed }
}`;

const DUPLICATE_MUTATION = `mutation AgentifyDuplicate($id: ID!, $name: String) {
  themeDuplicate(id: $id, name: $name) {
    newTheme { id name role processing }
    userErrors { field message code }
  }
}`;

const UPSERT_MUTATION = `mutation AgentifyUpsert($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
  themeFilesUpsert(themeId: $themeId, files: $files) {
    upsertedThemeFiles { filename }
    job { id done }
    userErrors { field message code filename }
  }
}`;

const JOB_QUERY = `query AgentifyJob($id: ID!) {
  job(id: $id) { id done }
}`;

const MAX_THEMES = 20;
const MAX_FILES = 200;
const MAX_FILE_BYTES = 1_000_000;
const UPSERT_BATCH = 50;
const PROCESSING_WAIT_MS = 90_000;

/** Theme roles that are safe to write to: never shown to customers. */
const WRITABLE_ROLES = new Set(['UNPUBLISHED', 'DEVELOPMENT']);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** "Agentify #12 – Size guide drawer", kept short enough for Shopify's theme name limit. */
export function previewThemeName(task: Pick<Task, 'number' | 'title'>): string {
  const name = `Agentify #${task.number} – ${task.title.replace(/\s+/g, ' ').trim()}`;
  return name.length > 50 ? `${name.slice(0, 49).trimEnd()}…` : name;
}

class DeployError extends Error {}

/** Validate the model-written files before anything is sent to the store. */
function checkBuildFiles(task: Task): { filename: string; content: string }[] {
  const files = task.build?.files ?? [];
  if (!files.length) throw new DeployError('There are no files in the build to deploy.');
  if (files.length > MAX_FILES) throw new DeployError(`The build has ${files.length} files; the limit for one deploy is ${MAX_FILES}.`);
  const seen = new Map<string, string>();
  for (const file of files) {
    let path: string;
    try {
      path = validateThemePath(file.path);
    } catch (err) {
      throw new DeployError(`The build contains an invalid file path. ${(err as Error).message}`);
    }
    if (typeof file.content !== 'string') throw new DeployError(`${path} has no text content.`);
    if (Buffer.byteLength(file.content, 'utf8') > MAX_FILE_BYTES) throw new DeployError(`${path} is larger than 1 MB.`);
    // The last version of a path wins, as it would in an editor.
    seen.set(path, file.content);
  }
  return [...seen].map(([filename, content]) => ({ filename, content }));
}

/** Wait until Shopify has finished copying/processing a theme. Never returns a live theme. */
async function waitForTheme(client: AdminClient, themeId: string): Promise<ThemeNode> {
  const deadline = Date.now() + PROCESSING_WAIT_MS;
  for (let delay = 1500; ; delay = Math.min(delay * 1.5, 5000)) {
    const { theme } = await client.query<{ theme: ThemeNode | null }>(THEME_QUERY, { id: themeId });
    if (!theme) throw new DeployError('The preview theme disappeared while it was being prepared. Deploy again.');
    if (theme.processingFailed) throw new DeployError(`Shopify could not finish copying the live theme into "${theme.name}". Delete that theme in Shopify admin → Online Store → Themes and deploy again.`);
    if (!theme.processing) return theme;
    if (Date.now() > deadline) {
      throw new DeployError(`Shopify is still copying the live theme into "${theme.name}". Wait a minute and deploy again; the same preview theme will be reused.`);
    }
    await sleep(delay);
  }
}

/** A message for the merchant when Shopify refuses a theme write. */
function accessDeniedHelp(domain: string, via: ShopifyConnection['via']): string {
  const fix = via === 'oauth'
    ? `Shopify only lets an app copy or edit themes once Shopify has granted that app its theme-modification exemption on top of the write_themes scope. ` +
      `Until the Agentify app has it, Relay cannot deploy previews`
    : `Check that the token belongs to a custom app created in this store’s admin (Settings → Apps and sales channels → Develop apps) and ` +
      `that the app has the write_themes scope, then reconnect the store in Agentify. If the scope is granted and this still fails, ` +
      `Shopify has not exempted the app for theme writes`;
  return `Shopify refused to create or change themes with this store’s authorization. ${fix}; the build’s files can be added by ` +
    `hand in the theme code editor (${themesAdminUrl(domain)}).`;
}

/**
 * Put task.build.files on an unpublished preview theme and return where to
 * see it. Must never write to the live theme. Failures are returned as
 * { status: 'failed', error }, not thrown.
 *
 * The first deploy of a task duplicates the live theme (so the new files
 * render in context) as "Agentify #N – title"; a re-deploy of the same task
 * reuses that theme while it is still unpublished.
 */
export async function deployPreview(workspace: Workspace, store: Store, task: Task): Promise<Deploy> {
  const at = Date.now();
  let client: AdminClient | null;
  try {
    client = await clientFor(workspace, store);
  } catch (err) {
    return { status: 'failed', at, error: (err as Error).message };
  }
  if (!client || !store.shopify) return { status: 'not_connected', at };
  const domain = client.domain;
  const via = store.shopify.via ?? 'token';
  let target: ThemeNode | null = null;

  try {
    const files = checkBuildFiles(task);

    // Scopes can change after connecting; check what the token has now.
    const { currentAppInstallation } = await client.query<{ currentAppInstallation: { accessScopes: { handle: string }[] } }>(SCOPES_QUERY);
    const scopes = currentAppInstallation.accessScopes.map((s) => s.handle).sort();
    const missing = missingScopes(scopes);
    if (missing.length) throw new DeployError(`Agentify can’t deploy because the authorization lacks ${missing.join(' and ')}. ${scopesHelp(missing, via)}`);

    const kv = getStore();
    const saved = await kv.get<StoredPreview>(previewKey(workspace.id, store.id, task.id));
    if (saved && saved.domain === domain) {
      const { theme } = await client.query<{ theme: ThemeNode | null }>(THEME_QUERY, { id: saved.themeId });
      // If the merchant published the preview, it is live now: leave it alone and make a new one.
      if (theme && WRITABLE_ROLES.has(theme.role)) target = theme;
    }

    if (!target) {
      const { themes } = await client.query<{ themes: { nodes: ThemeNode[] } }>(THEMES_QUERY);
      const live = themes.nodes.find((t) => t.role === 'MAIN');
      if (!live) throw new DeployError(`The store has no published theme to copy. Publish a theme first: ${themesAdminUrl(domain)}`);
      if (themes.nodes.length >= MAX_THEMES) {
        throw new DeployError(`The store already has ${themes.nodes.length} themes, Shopify’s maximum. Delete an unused theme in Online Store → Themes (${themesAdminUrl(domain)}) and deploy again.`);
      }
      const { themeDuplicate } = await client.query<{
        themeDuplicate: { newTheme: ThemeNode | null; userErrors: { field: string[] | null; message: string; code: string | null }[] };
      }>(DUPLICATE_MUTATION, { id: live.id, name: previewThemeName(task) });
      if (themeDuplicate.userErrors.length || !themeDuplicate.newTheme) {
        const msg = themeDuplicate.userErrors.map((e) => e.message).join(' ') || 'no theme was returned';
        throw new DeployError(`Shopify could not copy the live theme "${live.name}": ${msg}`);
      }
      target = themeDuplicate.newTheme;
      // Remember it before waiting, so a timed-out deploy is resumed rather than duplicated again.
      await kv.set<StoredPreview>(previewKey(workspace.id, store.id, task.id), { domain, themeId: target.id });
    }

    target = await waitForTheme(client, target.id);
    // The one hard rule: never write to a theme customers can see.
    if (!WRITABLE_ROLES.has(target.role)) throw new DeployError(`Refusing to write to "${target.name}" because it is not an unpublished theme.`);

    const written: string[] = [];
    const problems: string[] = [];
    for (let i = 0; i < files.length; i += UPSERT_BATCH) {
      const batch = files.slice(i, i + UPSERT_BATCH);
      const { themeFilesUpsert } = await client.query<{
        themeFilesUpsert: {
          upsertedThemeFiles: { filename: string }[] | null;
          job: { id: string; done: boolean } | null;
          userErrors: { field: string[] | null; message: string; code: string | null; filename: string | null }[];
        } | null;
      }>(UPSERT_MUTATION, {
        themeId: target.id,
        files: batch.map((f) => ({ filename: f.filename, body: { type: 'TEXT', value: f.content } })),
      });
      if (!themeFilesUpsert) throw new DeployError('Shopify did not accept the files.');
      written.push(...(themeFilesUpsert.upsertedThemeFiles ?? []).map((f) => f.filename));
      for (const e of themeFilesUpsert.userErrors) {
        if (e.code === 'ACCESS_DENIED') throw new DeployError(accessDeniedHelp(domain, via));
        if (e.code === 'THEME_LIMITED_PLAN') throw new DeployError('The store’s Shopify plan does not allow editing theme code. Upgrade the plan to deploy builds.');
        problems.push(`${e.filename ?? e.field?.join('.') ?? 'file'}: ${e.message}`);
      }
      if (themeFilesUpsert.job && !themeFilesUpsert.job.done) await waitForJob(client, themeFilesUpsert.job.id);
    }

    if (problems.length) {
      return {
        status: 'failed', at, themeId: target.id, themeName: target.name, files: written,
        error: `Shopify rejected ${problems.length} file${problems.length > 1 ? 's' : ''} on the preview theme "${target.name}":\n${problems.map((p) => `- ${p}`).join('\n')}`,
      };
    }

    return {
      status: 'deployed', at, themeId: target.id, themeName: target.name, files: written.length ? written : files.map((f) => f.filename),
      previewUrl: `https://${domain}/?preview_theme_id=${numericId(target.id)}`,
    };
  } catch (err) {
    let error: string;
    if (err instanceof DeployError) error = err.message;
    else if (err instanceof ShopifyError && err.code === 'access_denied') error = accessDeniedHelp(domain, via);
    else if (err instanceof ShopifyError || err instanceof HttpError) error = err.message;
    else {
      console.error('deployPreview failed', err instanceof Error ? err.name : 'unknown');
      error = 'The deploy failed unexpectedly. Try again; if it keeps failing, reconnect the store.';
    }
    return { status: 'failed', at, error, ...(target ? { themeId: target.id, themeName: target.name } : {}) };
  }
}

/** Upserts can finish asynchronously; give the job a short while so the preview shows the new files. */
async function waitForJob(client: AdminClient, jobId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(1000);
    const { job } = await client.query<{ job: { done: boolean } | null }>(JOB_QUERY, { id: jobId });
    if (!job || job.done) return;
  }
}
