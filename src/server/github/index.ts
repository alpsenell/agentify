/**
 * The theme repository: everything the agents and the app do against a
 * client's GitHub repository goes through this module.
 *
 * The workspace installs the Agentify GitHub App on its account and binds a
 * repository (owner/repo, base branch, theme folder) to each store. The
 * agents read the base branch; Relay puts approved work on an agentify/…
 * branch and opens a pull request. Nothing is pushed to the base branch and
 * nothing is merged.
 *
 * Installing: /api/github/install sends the owner to GitHub with a signed
 * state. The app has "Request user authorization (OAuth) during
 * installation" on, so GitHub comes back to the app's Callback URL
 * (/api/github/callback) with installation_id, state and a `code`. An
 * installation_id in a URL proves nothing, so the code is exchanged for a
 * user token and the installation must appear in that user's installations
 * before it is saved. The user token is then revoked.
 *
 * Required app permissions (repository): Contents read & write, Pull
 * requests read & write, Metadata read. No account permissions, no webhook.
 */
import { randomBytes } from 'node:crypto';
import type { GitHubInstall, PullRequest, RepoBinding, Store, Task, User, Workspace } from '../../agency/types';
import { HttpError, signValue, verifyValue } from '../auth';
import { getWorkspace, saveWorkspace } from '../repo';
import {
  type Gh, GitHubError, type UserInstallation, exchangeCode, findUserInstallation, installationClient, makeState,
  normaliseThemeRoot, readState, revokeUserToken, tokenCache,
  validateBranch, validateOwner, validateRepoName, type TokenCache,
} from './client';
import {
  type RepoOption, checkThemeFolder, getRepo, listBranches, listInstallationRepos, listThemeFiles, openOrUpdatePull,
  readThemeFile, repoSummary,
} from './ops';
import { ShopifyError } from '../shopify/admin';

export { API_VERSION, GitHubError } from './client';
export type { RepoOption } from './ops';

const env = (name: string): string | undefined => process.env[name] ?? (import.meta.env?.[name] as string | undefined);

/** Whether the Agentify GitHub App is configured on this server (all five settings; the install cannot be verified without the OAuth pair). */
export function githubConfigured(): boolean {
  return !!(env('GITHUB_APP_ID') && env('GITHUB_APP_PRIVATE_KEY') && env('GITHUB_APP_SLUG') && env('GITHUB_APP_CLIENT_ID') && env('GITHUB_APP_CLIENT_SECRET'));
}

const notConfigured = () => new HttpError(503, 'github_not_configured', 'GitHub is not configured on this server.');
const notInstalled = () => new HttpError(409, 'github_not_connected', 'Install the Agentify GitHub App first (Settings → GitHub).');
const notBound = () => new HttpError(409, 'repo_not_connected', 'No repository is connected to this store.');

/** Map a GitHubError (or a path error from the shared validator) onto the HTTP error the routes return. */
function toHttp(err: unknown): unknown {
  if (err instanceof ShopifyError) return new HttpError(400, `github_${err.code}`, err.message);
  if (!(err instanceof GitHubError)) return err;
  const status = {
    not_configured: 503, invalid_input: 400, installation_missing: 409, installation_suspended: 409,
    unauthorized: 502, forbidden: 403, not_found: 404, conflict: 409, unprocessable: 422,
    rate_limited: 429, github_error: 502, network_error: 502,
  }[err.code];
  return new HttpError(status, `github_${err.code}`, err.message);
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toHttp(err);
  }
}

/* ── clients ───────────────────────────────────────────────────────── */

let tokens: TokenCache | null = null;

function appTokens(): TokenCache {
  if (!githubConfigured()) throw notConfigured();
  tokens ??= tokenCache({ appId: env('GITHUB_APP_ID')!, privateKey: env('GITHUB_APP_PRIVATE_KEY')! });
  return tokens;
}

function clientFor(workspace: Workspace): Gh {
  if (!workspace.github) throw notInstalled();
  return installationClient(appTokens(), workspace.github.installationId);
}

function bound(workspace: Workspace, store: Store): { gh: Gh; binding: RepoBinding } {
  if (!store.repo) throw notBound();
  return { gh: clientFor(workspace), binding: store.repo };
}

/* ── install flow ──────────────────────────────────────────────────── */

const STATE_TTL_MS = 30 * 60_000;

const signer = { sign: signValue, verify: verifyValue };

/** The GitHub URL that installs the app, with a signed state bound to this workspace and user. */
export function installUrl(user: User): string {
  if (!githubConfigured()) throw notConfigured();
  const state = makeState(signer, user.workspaceId, user.id, randomBytes(9).toString('base64url'), Date.now() + STATE_TTL_MS);
  return `https://github.com/apps/${encodeURIComponent(env('GITHUB_APP_SLUG')!)}/installations/new?state=${encodeURIComponent(state)}`;
}

/** What the callback tells the settings page, as ?github=<outcome>. */
export type InstallOutcome =
  | 'connected' | 'requested' | 'unchanged' | 'invalid_state' | 'not_owner' | 'no_access' | 'no_code' | 'not_configured' | 'error';

/**
 * Finish the install from the callback's query. The signed-in user must be
 * the owner who started it, and GitHub must confirm (through the OAuth code)
 * that this user can access the installation.
 */
export async function completeInstall(
  user: User, workspace: Workspace,
  query: { installationId: string | null; setupAction: string | null; state: string | null; code: string | null },
): Promise<InstallOutcome> {
  if (!githubConfigured()) return 'not_configured';
  if (user.role !== 'owner') return 'not_owner';
  const id = Number(query.installationId);
  const state = readState(signer, query.state);

  // An org member asked an org owner to install it: nothing to save until the owner approves.
  if (query.setupAction === 'request') return 'requested';
  if (!Number.isSafeInteger(id) || id <= 0) return 'error';
  // GitHub can send people back here after they change the installation's repositories, without our state.
  if (!state) return workspace.github?.installationId === id ? 'unchanged' : 'invalid_state';
  if (state.w !== workspace.id || state.u !== user.id) return 'invalid_state';
  if (!query.code) return 'no_code';

  const creds = { clientId: env('GITHUB_APP_CLIENT_ID')!, clientSecret: env('GITHUB_APP_CLIENT_SECRET')! };
  let found: UserInstallation | null;
  try {
    const token = await exchangeCode(creds, query.code);
    try {
      found = await findUserInstallation(token, id);
    } finally {
      await revokeUserToken(creds, token);
    }
  } catch (err) {
    console.error('github install verification failed:', err instanceof GitHubError ? `${err.code} ${err.status}` : err);
    return 'error';
  }
  if (!found || found.suspended_at) return 'no_access';

  const fresh = (await getWorkspace(workspace.id)) ?? workspace;
  const changed = fresh.github?.installationId !== id;
  const install: GitHubInstall = { installationId: id, account: found.account?.login ?? 'GitHub', connectedAt: changed ? Date.now() : fresh.github!.connectedAt };
  fresh.github = install;
  // Repositories bound through a different installation may not be visible to this one.
  if (changed) for (const s of fresh.stores) s.repo = null;
  await saveWorkspace(fresh);
  return changed ? 'connected' : 'unchanged';
}

/** Forget the installation and every store's repository. The app stays installed on GitHub. */
export async function disconnectGithub(workspace: Workspace): Promise<Workspace> {
  const fresh = (await getWorkspace(workspace.id)) ?? workspace;
  if (fresh.github) tokens?.drop(fresh.github.installationId);
  fresh.github = null;
  for (const s of fresh.stores) s.repo = null;
  await saveWorkspace(fresh);
  return fresh;
}

/* ── repositories, branches, binding ───────────────────────────────── */

/** Repositories the installation can see. `truncated` when there were more than the cap. */
export async function listRepos(workspace: Workspace): Promise<{ repos: RepoOption[]; truncated: boolean }> {
  return guard(() => listInstallationRepos(clientFor(workspace)));
}

export async function listRepoBranches(workspace: Workspace, owner: unknown, repo: unknown): Promise<string[]> {
  return guard(() => listBranches(clientFor(workspace), validateOwner(owner), validateRepoName(repo)));
}

/** Validate and save a store's repository: the app can see it, the branch exists, the folder is a theme. */
export async function bindRepo(workspace: Workspace, storeId: string, input: Record<string, unknown>): Promise<Workspace> {
  return guard(async () => {
    const gh = clientFor(workspace);
    if (!workspace.stores.some((s) => s.id === storeId)) throw new HttpError(404, 'not_found', 'That store does not exist.');
    const owner = validateOwner(input.owner);
    const repo = validateRepoName(input.repo);
    const baseBranch = validateBranch(input.baseBranch);
    const themeRoot = normaliseThemeRoot(input.themeRoot);
    const info = await getRepo(gh, owner, repo);
    if (info.archived) throw new GitHubError('conflict', `${info.full_name} is archived, so pull requests cannot be opened on it. Unarchive it on GitHub or choose another repository.`, 409);
    // Keep GitHub's canonical casing.
    const binding: RepoBinding = { owner: info.owner.login, repo: info.name, baseBranch, themeRoot };
    const problem = await checkThemeFolder(gh, binding);
    if (problem) throw new GitHubError('invalid_input', `${problem[0]!.toUpperCase()}${problem.slice(1)}`, 400);

    const fresh = (await getWorkspace(workspace.id)) ?? workspace;
    const store = fresh.stores.find((s) => s.id === storeId);
    if (!store) throw new HttpError(404, 'not_found', 'That store does not exist.');
    store.repo = binding;
    await saveWorkspace(fresh);
    return fresh;
  });
}

export async function unbindRepo(workspace: Workspace, storeId: string): Promise<Workspace> {
  const fresh = (await getWorkspace(workspace.id)) ?? workspace;
  const store = fresh.stores.find((s) => s.id === storeId);
  if (!store) throw new HttpError(404, 'not_found', 'That store does not exist.');
  store.repo = null;
  await saveWorkspace(fresh);
  return fresh;
}

/* ── for the agents ────────────────────────────────────────────────── */

/** Theme-relative paths of files in the store's repository (base branch), optionally under a folder prefix. */
export async function listRepoThemeFiles(workspace: Workspace, store: Store, prefix?: string): Promise<string[]> {
  return guard(() => { const { gh, binding } = bound(workspace, store); return listThemeFiles(gh, binding, prefix); });
}

/** The text of one theme file in the store's repository (base branch). `path` is theme-relative. */
export async function readRepoThemeFile(workspace: Workspace, store: Store, path: string): Promise<string> {
  return guard(() => { const { gh, binding } = bound(workspace, store); return readThemeFile(gh, binding, path); });
}

/** A compact Markdown summary of the repository for an agent: name, base branch, theme root, layout. */
export async function repoContext(workspace: Workspace, store: Store): Promise<string> {
  return guard(() => { const { gh, binding } = bound(workspace, store); return repoSummary(gh, binding); });
}

/**
 * Put task.build.files on a branch for this task and open a pull request
 * against the base branch (or update the one already open). Never pushes to
 * the base branch and never merges. Failures are returned as
 * { status: 'failed', error }, not thrown. Returns null when the store has no repository.
 */
export async function openPullRequest(workspace: Workspace, store: Store, task: Task): Promise<PullRequest | null> {
  if (!store.repo) return null;
  let gh: Gh;
  try {
    gh = clientFor(workspace);
  } catch (err) {
    return { status: 'failed', at: Date.now(), error: err instanceof Error ? err.message.replace(/\.$/, '') : 'GitHub is not connected' };
  }
  return openOrUpdatePull(gh, store.repo, task);
}
