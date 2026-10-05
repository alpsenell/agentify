/**
 * What Agentify does in a theme repository, written against a Gh client so it
 * can be tested with a mocked fetch: listing repositories and branches,
 * checking that a folder is a theme, reading the base branch for the agents,
 * and putting a build on a branch with a pull request.
 *
 * Writes only ever go to `agentify/…` branches through the git data API
 * (blobs → tree → commit → ref) with fast-forward ref updates. Nothing here
 * pushes to the base branch, force-pushes or merges.
 */
import type { PullRequest, RepoBinding, Task } from '../../agency/types.ts';
import { THEME_FOLDERS, validateThemePath, validateThemePrefix } from '../shopify/admin.ts';
import { type Gh, GitHubError, encodePath, orNull, repoPath } from './client.ts';

/* ── shapes of the GitHub responses used ───────────────────────────── */

interface GhRepo {
  name: string;
  full_name: string;
  owner: { login: string };
  private: boolean;
  archived: boolean;
  disabled?: boolean;
  default_branch: string;
  html_url: string;
}
interface GhRef { ref: string; object: { sha: string; type: string } }
interface GhCommit { sha: string; tree: { sha: string } }
interface GhTreeEntry { path: string; mode: string; type: 'blob' | 'tree' | 'commit'; sha: string; size?: number }
interface GhTree { sha: string; tree: GhTreeEntry[]; truncated: boolean }
interface GhPull { number: number; html_url: string; state: 'open' | 'closed'; merged_at: string | null; head: { ref: string } }
interface GhPullFile { filename: string; status: string; previous_filename?: string }
interface GhContent { type: string; encoding?: string; content?: string; size: number; sha: string; path: string }

export interface RepoOption { owner: string; repo: string; defaultBranch: string; private: boolean }

/* ── repositories and branches ─────────────────────────────────────── */

/** Repositories listed for the picker. Installations rarely see more; beyond this the user types owner/repo. */
export const REPO_CAP = 500;
export const BRANCH_CAP = 500;

/** Repositories the installation can see, sorted, at most REPO_CAP. */
export async function listInstallationRepos(gh: Gh): Promise<{ repos: RepoOption[]; truncated: boolean }> {
  const repos: RepoOption[] = [];
  let total = 0;
  for (let page = 1; repos.length < REPO_CAP; page++) {
    const data = await gh.request<{ total_count: number; repositories: GhRepo[] }>('GET', `/installation/repositories?per_page=100&page=${page}`);
    total = data.total_count;
    repos.push(...data.repositories.filter((r) => !r.archived).map((r) => ({
      owner: r.owner.login, repo: r.name, defaultBranch: r.default_branch, private: r.private,
    })));
    if (data.repositories.length < 100) break;
  }
  repos.sort((a, b) => `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`));
  return { repos: repos.slice(0, REPO_CAP), truncated: total > REPO_CAP };
}

/** The repository, or a GitHubError saying the installation cannot see it. */
export async function getRepo(gh: Gh, owner: string, repo: string): Promise<GhRepo> {
  const found = await orNull(gh.request<GhRepo>('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`));
  if (!found) {
    throw new GitHubError('not_found', `The Agentify GitHub App cannot see ${owner}/${repo}. On GitHub, open the app’s installation settings and give it access to this repository.`, 404);
  }
  return found;
}

/** Branch names, the default branch first, at most BRANCH_CAP. */
export async function listBranches(gh: Gh, owner: string, repo: string): Promise<string[]> {
  const info = await getRepo(gh, owner, repo);
  const names: string[] = [];
  for (let page = 1; names.length < BRANCH_CAP; page++) {
    const data = await gh.request<{ name: string }[]>('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100&page=${page}`);
    names.push(...data.map((b) => b.name));
    if (data.length < 100) break;
  }
  const rest = names.filter((n) => n !== info.default_branch).sort((a, b) => a.localeCompare(b));
  return [...(names.includes(info.default_branch) ? [info.default_branch] : []), ...rest].slice(0, BRANCH_CAP);
}

const repoUrl = (b: Pick<RepoBinding, 'owner' | 'repo'>) => `/repos/${encodeURIComponent(b.owner)}/${encodeURIComponent(b.repo)}`;

/** The commit at the tip of a branch, or null when the branch does not exist. */
async function branchTip(gh: Gh, b: Pick<RepoBinding, 'owner' | 'repo'>, branch: string): Promise<string | null> {
  let ref: GhRef | null;
  try {
    ref = await orNull(gh.request<GhRef>('GET', `${repoUrl(b)}/git/ref/heads/${encodePath(branch)}`));
  } catch (err) {
    if (err instanceof GitHubError && err.code === 'conflict') {
      throw new GitHubError('conflict', `${b.owner}/${b.repo} is empty. Push the theme to it first.`, 409);
    }
    throw err;
  }
  // A ref lookup that does not match exactly returns the refs it prefixes (an array): treat as missing.
  return ref && !Array.isArray(ref) && ref.object?.sha ? ref.object.sha : null;
}

/* ── the theme folder ──────────────────────────────────────────────── */

interface ThemeTree {
  commitSha: string;
  /** Tree of the repository root at that commit. */
  rootTree: GhTree;
  /** Tree of the theme folder (same as rootTree when themeRoot is ""). */
  themeTree: GhTree;
}

/** Walk from the branch tip down to the theme folder, one tree per segment. */
async function themeTree(gh: Gh, binding: RepoBinding, branch = binding.baseBranch): Promise<ThemeTree> {
  const commitSha = await branchTip(gh, binding, branch);
  if (!commitSha) throw new GitHubError('not_found', `Branch "${branch}" does not exist in ${binding.owner}/${binding.repo}.`, 404);
  const commit = await gh.request<GhCommit>('GET', `${repoUrl(binding)}/git/commits/${commitSha}`);
  const rootTree = await gh.request<GhTree>('GET', `${repoUrl(binding)}/git/trees/${commit.tree.sha}`);
  let tree = rootTree;
  for (const segment of binding.themeRoot ? binding.themeRoot.split('/') : []) {
    const entry = tree.tree.find((e) => e.path === segment && e.type === 'tree');
    if (!entry) throw new GitHubError('not_found', `There is no folder "${binding.themeRoot}" on ${branch} in ${binding.owner}/${binding.repo}.`, 404);
    tree = await gh.request<GhTree>('GET', `${repoUrl(binding)}/git/trees/${entry.sha}`);
  }
  return { commitSha, rootTree, themeTree: tree };
}

export const THEME_MARKERS = ['layout/theme.liquid', 'sections/', 'templates/', 'config/settings_schema.json'];

/** null when the folder looks like a Shopify theme, otherwise a message saying what was looked for. */
export async function checkThemeFolder(gh: Gh, binding: RepoBinding): Promise<string | null> {
  const { themeTree: tree } = await themeTree(gh, binding);
  const dir = (name: string) => tree.tree.find((e) => e.path === name && e.type === 'tree');
  if (dir('sections') || dir('templates')) return null;
  for (const [folder, file] of [['layout', 'theme.liquid'], ['config', 'settings_schema.json']] as const) {
    const sub = dir(folder);
    if (!sub) continue;
    const listing = await gh.request<GhTree>('GET', `${repoUrl(binding)}/git/trees/${sub.sha}`);
    if (listing.tree.some((e) => e.path === file && e.type === 'blob')) return null;
  }
  const where = binding.themeRoot ? `the folder "${binding.themeRoot}"` : 'the repository root';
  return `${where} of ${binding.owner}/${binding.repo} (${binding.baseBranch}) does not look like a Shopify theme: none of ${THEME_MARKERS.join(', ')} is there. Choose the folder that contains layout/, sections/ and templates/.`;
}

/* ── reading for the agents ────────────────────────────────────────── */

/** Same caps as reading from the live theme. */
export const LIST_CAP = 2_000;
export const READ_CAP = 60_000;

const isThemePath = (path: string) => (THEME_FOLDERS as readonly string[]).includes(path.split('/')[0]!);

/**
 * Every file of the theme folder (recursive tree of the theme folder only).
 * If GitHub truncates the recursive tree, each theme folder is listed on its
 * own; whatever still cannot be listed is said so in the last line.
 */
async function themeFileList(gh: Gh, binding: RepoBinding): Promise<{ files: GhTreeEntry[]; incomplete: string[]; tree: ThemeTree }> {
  const tree = await themeTree(gh, binding);
  const full = await gh.request<GhTree>('GET', `${repoUrl(binding)}/git/trees/${tree.themeTree.sha}?recursive=1`);
  if (!full.truncated) return { files: full.tree.filter((e) => e.type === 'blob' && isThemePath(e.path)), incomplete: [], tree };
  const files: GhTreeEntry[] = [];
  const incomplete: string[] = [];
  for (const folder of tree.themeTree.tree.filter((e) => e.type === 'tree' && isThemePath(e.path))) {
    const sub = await gh.request<GhTree>('GET', `${repoUrl(binding)}/git/trees/${folder.sha}?recursive=1`);
    if (sub.truncated) incomplete.push(`${folder.path}/`);
    files.push(...sub.tree.filter((e) => e.type === 'blob').map((e) => ({ ...e, path: `${folder.path}/${e.path}` })));
  }
  return { files, incomplete, tree };
}

/** Theme-relative paths on the base branch, optionally under a prefix. */
export async function listThemeFiles(gh: Gh, binding: RepoBinding, prefix?: string): Promise<string[]> {
  const safePrefix = validateThemePrefix(prefix);
  const { files, incomplete } = await themeFileList(gh, binding);
  const paths = files.map((f) => f.path).filter((p) => p.startsWith(safePrefix)).sort();
  const out = paths.slice(0, LIST_CAP);
  if (paths.length > LIST_CAP) out.push(`(list cut at ${LIST_CAP} files; pass a narrower prefix such as "sections/" to see the rest)`);
  const missed = incomplete.filter((f) => f.startsWith(safePrefix) || safePrefix.startsWith(f));
  if (missed.length) out.push(`(GitHub truncated the listing of ${missed.join(', ')}: some files there are not shown; read them by path if you know it)`);
  return out;
}

const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|wav|pdf|zip|gz)$/i;

/** One file from the base branch, as text. Long files are cut with a note; binary files are described in one line. */
export async function readThemeFile(gh: Gh, binding: RepoBinding, path: string): Promise<string> {
  const safe = validateThemePath(path);
  const full = repoPath(binding.themeRoot, safe);
  const node = await orNull(gh.request<GhContent | GhContent[]>('GET', `${repoUrl(binding)}/contents/${encodePath(full)}?ref=${encodeURIComponent(binding.baseBranch)}`));
  if (!node) throw new GitHubError('not_found', `There is no file ${safe} on ${binding.baseBranch} in ${binding.owner}/${binding.repo}.`, 404);
  if (Array.isArray(node) || node.type !== 'file') throw new GitHubError('invalid_input', `${safe} is a folder, not a file. List it with a prefix instead.`);
  if (BINARY_EXT.test(safe)) return `[${safe} is a binary file (${node.size} bytes); its content is not shown.]`;
  let buf: Buffer;
  if (node.encoding === 'base64' && typeof node.content === 'string') {
    buf = Buffer.from(node.content, 'base64');
  } else {
    // Over 1 MB the contents API omits the body; the blob API still has it.
    const blob = await gh.request<{ content: string; encoding: string }>('GET', `${repoUrl(binding)}/git/blobs/${node.sha}`);
    buf = Buffer.from(blob.content, blob.encoding === 'base64' ? 'base64' : 'utf8');
  }
  if (buf.subarray(0, 8000).includes(0)) return `[${safe} is a binary file (${node.size} bytes); its content is not shown.]`;
  const content = buf.toString('utf8');
  if (content.length <= READ_CAP) return content;
  return `${content.slice(0, READ_CAP)}\n\n[truncated: showing the first ${READ_CAP.toLocaleString('en-US')} of ${content.length.toLocaleString('en-US')} characters of ${safe}]`;
}

/** Compact Markdown about the repository: what changes how Volt should write files. */
export async function repoSummary(gh: Gh, binding: RepoBinding): Promise<string> {
  const info = await getRepo(gh, binding.owner, binding.repo);
  const { files, incomplete, tree } = await themeFileList(gh, binding);
  const counts = new Map<string, number>();
  for (const f of files) counts.set(f.path.split('/')[0]!, (counts.get(f.path.split('/')[0]!) ?? 0) + 1);
  const jsonTemplates = files.filter((f) => /^templates\/(customers\/)?[^/]+\.json$/.test(f.path)).length;
  const liquidTemplates = files.filter((f) => /^templates\/(customers\/)?[^/]+\.liquid$/.test(f.path)).length;
  const hasBlocks = (counts.get('blocks') ?? 0) > 0;

  const lines = [
    '## Theme repository',
    `- Repository: ${info.full_name}${info.private ? ' (private)' : ''}${info.archived ? ' — **archived, read-only**' : ''}`,
    `- Base branch: \`${binding.baseBranch}\`. Approved work arrives as a pull request against it; Agentify never pushes to it.`,
    `- Theme folder: ${binding.themeRoot ? `\`${binding.themeRoot}/\`` : 'the repository root'}. Write theme-relative paths (e.g. \`sections/x.liquid\`); they are placed under this folder.`,
    `- Architecture: ${jsonTemplates ? `Online Store 2.0 (${jsonTemplates} JSON templates${liquidTemplates ? `, ${liquidTemplates} Liquid` : ''})` : liquidTemplates ? `legacy (Liquid templates only, ${liquidTemplates}); sections cannot be added to templates in the editor` : 'unknown (no templates found)'}${hasBlocks ? '; uses theme blocks (blocks/)' : ''}.`,
    `- Theme files: ${[...counts].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}/ ${v}`).join(', ') || 'none'}${incomplete.length ? ` (listing incomplete for ${incomplete.join(', ')})` : ''}.`,
  ];

  // Tooling at the repository root and in the theme folder.
  const top = (t: GhTree) => new Map(t.tree.map((e) => [e.path, e]));
  const rootEntries = top(tree.rootTree);
  const themeEntries = top(tree.themeTree);
  const anywhere = (name: string) => rootEntries.get(name) ?? themeEntries.get(name);
  const notes: string[] = [];
  const themeCheck = ['.theme-check.yml', '.theme-check.yaml'].find((n) => anywhere(n));
  if (themeCheck) notes.push(`a Theme Check config (\`${themeCheck}\`): follow its rules`);
  if (anywhere('.shopifyignore')) notes.push('a `.shopifyignore`');
  if (anywhere('shopify.theme.toml')) notes.push('`shopify.theme.toml` (Shopify CLI environments)');
  if (rootEntries.get('.github')?.type === 'tree') notes.push('GitHub workflows/config in `.github/` (CI may run on the pull request)');
  const pkg = anywhere('package.json');
  if (pkg?.type === 'blob') {
    try {
      const blob = await gh.request<{ content: string; encoding: string }>('GET', `${repoUrl(binding)}/git/blobs/${pkg.sha}`);
      const json = JSON.parse(Buffer.from(blob.content, blob.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8')) as {
        scripts?: Record<string, string>; devDependencies?: Record<string, string>; dependencies?: Record<string, string>;
      };
      const scripts = Object.entries(json.scripts ?? {}).filter(([k]) => /^(build|dev|watch|start)/.test(k));
      const tools = Object.keys({ ...json.dependencies, ...json.devDependencies })
        .filter((d) => /^(tailwindcss|vite|webpack|esbuild|rollup|parcel|postcss|sass|typescript|@shopify\/theme)/.test(d));
      notes.push(`a package.json${scripts.length ? ` with ${scripts.map(([k, v]) => `\`${k}\`: \`${v.slice(0, 80)}\``).join(', ')}` : ''}${tools.length ? ` (uses ${tools.join(', ')})` : ''}`);
      if (scripts.some(([k]) => k.startsWith('build'))) {
        notes.push('**a build step**: some files in assets/ may be compiled output. Before editing an asset, check whether a source folder (e.g. `src/`) produces it; if it does, keep your change in a new asset file or Liquid and say so in the install notes rather than editing compiled output');
      }
    } catch {
      notes.push('a package.json (could not be read)');
    }
  }
  const otherTop = [...rootEntries.values()].filter((e) => e.type === 'tree' && !isThemePath(e.path) && !e.path.startsWith('.') && e.path !== binding.themeRoot.split('/')[0]).map((e) => `${e.path}/`);
  if (otherTop.length) notes.push(`other top-level folders: ${otherTop.slice(0, 12).join(', ')}`);
  lines.push(notes.length ? `- Tooling: ${notes.join('; ')}.` : '- Tooling: none detected (no Theme Check config, no package.json build step).');
  return lines.join('\n');
}

/* ── the pull request ──────────────────────────────────────────────── */

/** "Add a size guide to product pages!" → "add-a-size-guide-to-product-pages". */
export function slugify(title: string): string {
  const slug = title.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return slug || 'request';
}

export const branchName = (task: Pick<Task, 'number' | 'title'>) => `agentify/${task.number}-${slugify(task.title)}`;

const checkbox = (done: boolean, text: string) => `- [${done ? 'x' : ' '}] ${text.replace(/\n+/g, ' ')}`;

/** The pull request description, built from the task. */
export function prBody(task: Task): string {
  const parts: string[] = [];
  const build = task.build;
  if (task.brief) {
    parts.push(`## Summary\n\n${task.brief.summary}`);
    if (task.brief.acceptanceCriteria.length) {
      const passed = new Map((task.review?.checks ?? []).map((c) => [c.criterion, c.pass]));
      parts.push(`## Acceptance criteria\n\n${task.brief.acceptanceCriteria.map((c) => checkbox(passed.get(c) === true, c)).join('\n')}`);
    }
  }
  if (build?.summary) parts.push(`## What changed\n\n${build.summary}\n\n${build.files.map((f) => `- \`${f.path}\``).join('\n')}`);
  if (task.feasibility?.edgeCases.length) parts.push(`## Edge cases (from Forge)\n\n${task.feasibility.edgeCases.map((e) => `- ${e}`).join('\n')}`);
  if (build?.installNotes) parts.push(`## Install notes\n\n${build.installNotes}`);
  if (task.review) {
    const failing = task.review.checks.filter((c) => !c.pass);
    parts.push(`## QA (Sieve)\n\nVerdict: **${task.review.verdict === 'pass' ? 'pass' : 'fail'}**${failing.length ? `\n\n${failing.map((c) => `- ✗ ${c.criterion}: ${c.note}`).join('\n')}` : ''}${task.review.issues.length ? `\n\nIssues:\n${task.review.issues.map((i) => `- ${i}`).join('\n')}` : ''}`);
  }
  if (build) {
    parts.push(build.checks === null
      ? '## Automated checks\n\nThe automated checks could not run on this build.'
      : build.checks.length
        ? `## Automated checks\n\n${build.checks.slice(0, 50).map((c) => `- **${c.severity}** \`${c.path}${c.line ? `:${c.line}` : ''}\` ${c.check}: ${c.message}`).join('\n')}${build.checks.length > 50 ? `\n- …and ${build.checks.length - 50} more` : ''}`
        : '## Automated checks\n\nNo findings.');
  }
  parts.push(`---\nOpened by Agentify for request #${task.number}${build ? ` (build round ${build.round})` : ''}. Nothing is merged automatically: review and merge it when you are happy.`);
  // GitHub caps a PR body at 65,536 characters.
  const body = parts.join('\n\n');
  return body.length > 65_000 ? `${body.slice(0, 64_900)}\n\n…(cut to fit GitHub's limit)` : body;
}

/** An actionable sentence for a failed pull request. */
export function describePrFailure(err: unknown, binding: RepoBinding, branch?: string): string {
  const where = `${binding.owner}/${binding.repo}`;
  if (!(err instanceof GitHubError)) return `something went wrong talking to GitHub (${(err as Error)?.message ?? 'unknown error'})`;
  const detail = err.detail.toLowerCase();
  if (err.code === 'installation_missing' || err.code === 'installation_suspended' || err.code === 'not_configured' || err.code === 'rate_limited' || err.code === 'invalid_input') return err.message;
  if (detail.includes('archived')) return `${where} is archived, so it is read-only. Unarchive it on GitHub, or connect a different repository in Settings`;
  if (/protected branch|branch protection|repository rule|ruleset|rule violation/.test(detail)) {
    return `a branch protection rule or ruleset on ${where} refused the push to ${branch ?? 'the agentify/ branch'}. Allow the Agentify app to create and push to branches matching agentify/* (Settings → Rules / Branches on GitHub)`;
  }
  if (err.code === 'forbidden' || (err.code === 'not_found' && err.permissions)) {
    const perms = err.permissions
      ? err.permissions.split(/[,;]\s*/).map((p) => p.replace('contents', 'Contents').replace('pull_requests', 'Pull requests').replace('metadata', 'Metadata').replace('=', ': ')).join(' and ')
      : 'Contents: read and write, and Pull requests: read and write';
    return `the Agentify GitHub App is missing a permission on ${where} (needs ${perms}). An owner of ${binding.owner} must accept the app’s permissions on GitHub (Settings → Applications → Installed GitHub Apps → Agentify)`;
  }
  // Our own not-found messages (no GitHub detail) already say what is missing.
  if (err.code === 'not_found' && !err.detail) return err.message.replace(/\.$/, '');
  if (err.code === 'not_found') return `the GitHub App can no longer see ${where} (the repository was removed from the app’s access, renamed or deleted). Check the installation on GitHub, then reconnect the repository in Settings`;
  if (err.code === 'conflict') return err.message.replace(/\.$/, '');
  if (err.code === 'unprocessable' && /fast forward/.test(detail)) return `someone else pushed to ${branch} while Agentify was updating it. Approve again to retry`;
  return err.message.replace(/\.$/, '');
}

/** Every file Volt wrote, re-validated (the paths are model-written) and placed under the theme root. */
function buildEntries(task: Task, binding: RepoBinding): { path: string; content: string }[] {
  const files = task.build?.files ?? [];
  if (!files.length) throw new GitHubError('invalid_input', 'the build has no files to put in a pull request');
  const seen = new Set<string>();
  return files.map((f) => {
    let safe: string;
    try {
      safe = validateThemePath(f.path);
    } catch (err) {
      throw new GitHubError('invalid_input', `the build contains a file path that is not allowed (${(err as Error).message})`);
    }
    if (seen.has(safe)) throw new GitHubError('invalid_input', `the build contains ${safe} twice`);
    seen.add(safe);
    return { path: repoPath(binding.themeRoot, safe), content: f.content };
  });
}

interface Target {
  branch: string;
  /** Tip of the branch when it already exists. */
  tip: string | null;
  /** The open pull request from it, when there is one. */
  pull: GhPull | null;
}

const MAX_SUFFIX = 20;

/**
 * Which branch to use: the task's earlier branch while its PR is open (a
 * rework adds a commit there), otherwise the first `agentify/<n>-<slug>[-k]`
 * whose PR (if any) is still open, or that has no PR yet.
 */
async function chooseTarget(gh: Gh, binding: RepoBinding, task: Task): Promise<Target> {
  const base = branchName(task);
  const prior = task.pullRequest?.branch && task.pullRequest.branch.startsWith(`agentify/${task.number}-`) ? [task.pullRequest.branch] : [];
  const candidates = [...new Set([...prior, base, ...Array.from({ length: MAX_SUFFIX - 1 }, (_, i) => `${base}-${i + 2}`)])];
  for (const branch of candidates) {
    const pulls = await gh.request<GhPull[]>('GET', `${repoUrl(binding)}/pulls?state=all&per_page=20&head=${encodeURIComponent(`${binding.owner}:${branch}`)}`);
    const open = pulls.find((p) => p.state === 'open') ?? null;
    if (!open && pulls.length) continue; // merged or closed: start fresh
    const tip = await branchTip(gh, binding, branch);
    if (open && !tip) continue; // PR open but its branch is gone: cannot add to it
    return { branch, tip, pull: open };
  }
  throw new GitHubError('conflict', `every agentify/${task.number}-… branch name is taken by a closed pull request. Delete some of those branches on GitHub and approve again`);
}

async function createBlob(gh: Gh, binding: RepoBinding, content: string): Promise<string> {
  const blob = await gh.request<{ sha: string }>('POST', `${repoUrl(binding)}/git/blobs`, { content, encoding: 'utf-8' });
  return blob.sha;
}

/**
 * Put the build on a branch in ONE commit and open (or update) the pull
 * request. Returns a failed PullRequest with an actionable message rather
 * than throwing.
 */
export async function openOrUpdatePull(gh: Gh, binding: RepoBinding, task: Task, now = Date.now()): Promise<PullRequest> {
  let branch: string | undefined;
  try {
    const entries = buildEntries(task, binding);
    const info = await getRepo(gh, binding.owner, binding.repo);
    if (info.archived) throw new GitHubError('forbidden', '', 403, 'Repository was archived so is read-only.');
    const baseTip = await branchTip(gh, binding, binding.baseBranch);
    if (!baseTip) throw new GitHubError('conflict', `the base branch "${binding.baseBranch}" no longer exists in ${binding.owner}/${binding.repo}. Choose another branch in Settings`);

    const target = await chooseTarget(gh, binding, task);
    branch = target.branch;
    if (target.branch === binding.baseBranch) throw new GitHubError('invalid_input', 'refusing to write to the base branch');
    const parent = target.tip ?? baseTip;
    const parentCommit = await gh.request<GhCommit>('GET', `${repoUrl(binding)}/git/commits/${parent}`);

    const tree: { path: string; mode: '100644'; type: 'blob'; sha: string | null }[] = [];
    for (const entry of entries) tree.push({ path: entry.path, mode: '100644', type: 'blob', sha: await createBlob(gh, binding, entry.content) });

    // On a rework, files the earlier round changed but this round does not are put back as they are on the base branch.
    if (target.pull) {
      const written = new Set(entries.map((e) => e.path));
      const changed: GhPullFile[] = [];
      for (let page = 1; page <= 10; page++) {
        const batch = await gh.request<GhPullFile[]>('GET', `${repoUrl(binding)}/pulls/${target.pull.number}/files?per_page=100&page=${page}`);
        changed.push(...batch);
        if (batch.length < 100) break;
      }
      const stale = changed.map((f) => f.filename).filter((p) => !written.has(p) && (!binding.themeRoot || p.startsWith(`${binding.themeRoot}/`)));
      if (stale.length) {
        const baseCommit = await gh.request<GhCommit>('GET', `${repoUrl(binding)}/git/commits/${baseTip}`);
        const baseFiles = await gh.request<GhTree>('GET', `${repoUrl(binding)}/git/trees/${baseCommit.tree.sha}?recursive=1`);
        const onBase = new Map(baseFiles.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
        for (const path of stale) {
          // With a truncated base listing, a path we cannot see is left alone rather than deleted.
          if (!onBase.has(path) && baseFiles.truncated) continue;
          tree.push({ path, mode: '100644', type: 'blob', sha: onBase.get(path) ?? null });
        }
      }
    }

    const newTree = await gh.request<{ sha: string }>('POST', `${repoUrl(binding)}/git/trees`, { base_tree: parentCommit.tree.sha, tree });
    let head = parent;
    if (newTree.sha !== parentCommit.tree.sha) {
      const round = task.build?.round ?? 1;
      const commit = await gh.request<{ sha: string }>('POST', `${repoUrl(binding)}/git/commits`, {
        message: `Agentify #${task.number}: ${task.title}${round > 1 ? ` (round ${round})` : ''}\n\n${task.build?.summary ?? ''}`.trim(),
        tree: newTree.sha,
        parents: [parent],
      });
      head = commit.sha;
      if (target.tip) {
        // Fast-forward only: never force.
        await gh.request('PATCH', `${repoUrl(binding)}/git/refs/heads/${encodePath(target.branch)}`, { sha: head, force: false });
      } else {
        try {
          await gh.request('POST', `${repoUrl(binding)}/git/refs`, { ref: `refs/heads/${target.branch}`, sha: head });
        } catch (err) {
          // A retried POST may have created it already.
          if (!(err instanceof GitHubError && err.code === 'unprocessable' && (await branchTip(gh, binding, target.branch)) === head)) throw err;
        }
      }
    } else if (!target.tip) {
      throw new GitHubError('invalid_input', `the build is identical to ${binding.baseBranch}, so there is nothing to propose`);
    }

    const title = `Agentify #${task.number}: ${task.title}`.slice(0, 250);
    const body = prBody(task);
    if (target.pull) {
      await gh.request('PATCH', `${repoUrl(binding)}/pulls/${target.pull.number}`, { body });
      return { status: 'updated', at: now, url: target.pull.html_url, number: target.pull.number, branch: target.branch };
    }
    let pull: GhPull;
    try {
      pull = await gh.request<GhPull>('POST', `${repoUrl(binding)}/pulls`, { title, head: target.branch, base: binding.baseBranch, body, draft: false });
    } catch (err) {
      // A retried POST may have opened it already.
      if (!(err instanceof GitHubError && err.code === 'unprocessable' && /already exists/i.test(err.detail))) throw err;
      const existing = await gh.request<GhPull[]>('GET', `${repoUrl(binding)}/pulls?state=open&head=${encodeURIComponent(`${binding.owner}:${target.branch}`)}`);
      if (!existing[0]) throw err;
      pull = existing[0];
    }
    return { status: 'opened', at: now, url: pull.html_url, number: pull.number, branch: target.branch };
  } catch (err) {
    return { status: 'failed', at: now, ...(branch ? { branch } : {}), error: describePrFailure(err, binding, branch) };
  }
}
