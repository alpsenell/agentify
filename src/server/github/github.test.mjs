/**
 * Checks for the GitHub client and repository operations against a mocked
 * fetch: the app JWT, token caching, retries, input validation, theme
 * detection, reading, and the pull request (new branch, rework on the same
 * branch, merged PR → new branch) and its failure messages. No network.
 *
 *   node --experimental-strip-types --test src/server/github/github.test.mjs
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';
import {
  API_VERSION, GitHubError, appJwt, installationClient, normalisePem, normaliseThemeRoot, tokenCache,
  validateBranch, validateOwner, validateRepoName, exchangeCode, findUserInstallation, makeState, readState,
} from './client.ts';
import {
  branchName, checkThemeFolder, listThemeFiles, openOrUpdatePull, prBody, readThemeFile, repoSummary, slugify,
} from './ops.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PKCS1 = privateKey.export({ type: 'pkcs1', format: 'pem' });
const PKCS8 = privateKey.export({ type: 'pkcs8', format: 'pem' });

const code = async (fn) => { try { await fn(); } catch (e) { return e instanceof GitHubError ? e.code : `other:${e?.message ?? e}`; } return 'ok'; };
const noWait = async () => {};

/* ── a tiny fake GitHub ────────────────────────────────────────────── */

const jsonRes = (status, body, headers = {}) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** routes: [method, RegExp on path+query, handler(match, body, init) → Response | object]. Unmatched → 404. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const target = u.pathname + u.search;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, target, body, headers: init.headers, host: u.host });
    for (const [m, re, handler] of routes) {
      const match = m === method ? re.exec(target) : null;
      if (match) {
        const out = await handler(match, body, init);
        return out instanceof Response ? out : jsonRes(200, out);
      }
    }
    return jsonRes(404, { message: 'Not Found' });
  };
  return { impl, calls };
}

const tokenRoute = (counter) => ['POST', /^\/app\/installations\/(\d+)\/access_tokens$/, () => {
  counter.n++;
  return jsonRes(201, { token: `ghs_token${counter.n}`, expires_at: new Date(Date.now() + 3600_000).toISOString() });
}];

function gh(routes, extra = {}) {
  const counter = { n: 0 };
  const f = fakeFetch([tokenRoute(counter), ...routes]);
  const tokens = tokenCache({ appId: '123', privateKey: PKCS1 }, { fetchImpl: f.impl, wait: noWait, ...extra });
  return { client: installationClient(tokens, 42, { fetchImpl: f.impl, wait: noWait, ...extra }), calls: f.calls, counter, tokens };
}

/* ── JWT ───────────────────────────────────────────────────────────── */

test('appJwt is RS256, verifiable with the public key, with backdated iat and exp ≤ 10 minutes', () => {
  const now = 1_800_000_000_000;
  for (const pem of [PKCS1, PKCS8, PKCS1.replace(/\n/g, '\\n'), `"${PKCS8.replace(/\n/g, '\\n')}"`, Buffer.from(PKCS1).toString('base64')]) {
    const jwt = appJwt('123', pem, now);
    const [h, p, s] = jwt.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(p, 'base64url'));
    assert.equal(claims.iss, '123');
    assert.equal(claims.iat, now / 1000 - 60);
    assert.ok(claims.exp - now / 1000 <= 600 && claims.exp > now / 1000);
    assert.ok(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')));
  }
  assert.match(normalisePem('a\\nb'), /^a\nb\n$/);
});

test('appJwt refuses a key that is not a PEM private key', async () => {
  assert.equal(await code(() => appJwt('1', 'not a key')), 'not_configured');
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.equal(await code(() => appJwt('1', ec)), 'not_configured');
});

/* ── tokens and the client ─────────────────────────────────────────── */

test('installation tokens are cached until close to expiry, and never minted twice concurrently', async () => {
  let now = Date.now();
  const counter = { n: 0 };
  const f = fakeFetch([
    ['POST', /access_tokens$/, () => { counter.n++; return jsonRes(201, { token: `ghs_${counter.n}`, expires_at: new Date(now + 3600_000).toISOString() }); }],
  ]);
  const cache = tokenCache({ appId: '1', privateKey: PKCS8 }, { fetchImpl: f.impl, wait: noWait, now: () => now });
  const [a, b] = await Promise.all([cache.get(7), cache.get(7)]);
  assert.equal(a, 'ghs_1'); assert.equal(b, 'ghs_1'); assert.equal(counter.n, 1);
  now += 50 * 60_000; // 10 minutes left: still fine
  assert.equal(await cache.get(7), 'ghs_1');
  now += 6 * 60_000; // 4 minutes left: refresh
  assert.equal(await cache.get(7), 'ghs_2');
  // The token request is authenticated with the app JWT.
  assert.match(f.calls[0].headers.Authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  assert.equal(f.calls[0].headers['X-GitHub-Api-Version'], API_VERSION);
});

test('a removed installation maps to installation_missing', async () => {
  const f = fakeFetch([]);
  const cache = tokenCache({ appId: '1', privateKey: PKCS1 }, { fetchImpl: f.impl, wait: noWait });
  assert.equal(await code(() => cache.get(9)), 'installation_missing');
});

test('client retries 5xx and secondary rate limits with Retry-After, uses the token, and drops it on 401', async () => {
  let n = 0;
  const waits = [];
  const { client, calls, counter } = gh([
    ['GET', /^\/flaky$/, () => (++n === 1 ? jsonRes(502, { message: 'bad gateway' })
      : n === 2 ? jsonRes(403, { message: 'You have exceeded a secondary rate limit.' }, { 'retry-after': '2' }) : { ok: true })],
    ['GET', /^\/revoked$/, (_m, _b, init) => (init.headers.Authorization === 'Bearer ghs_token1' ? jsonRes(401, { message: 'Bad credentials' }) : { ok: 'fresh' })],
  ], { wait: async (ms) => { waits.push(ms); } });
  assert.deepEqual(await client.request('GET', '/flaky'), { ok: true });
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(calls.find((c) => c.target === '/flaky').headers.Authorization, 'Bearer ghs_token1');
  assert.deepEqual(await client.request('GET', '/revoked'), { ok: 'fresh' });
  assert.equal(counter.n, 2);
});

test('a long primary rate limit fails instead of waiting; refusals carry GitHub permissions', async () => {
  const { client } = gh([
    ['GET', /^\/limited$/, () => jsonRes(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3000) })],
    ['GET', /^\/denied$/, () => jsonRes(403, { message: 'Resource not accessible by integration' }, { 'x-accepted-github-permissions': 'contents=write' })],
  ]);
  assert.equal(await code(() => client.request('GET', '/limited')), 'rate_limited');
  try { await client.request('GET', '/denied'); assert.fail(); } catch (e) {
    assert.equal(e.code, 'forbidden'); assert.equal(e.permissions, 'contents=write');
    assert.doesNotMatch(e.message, /ghs_/);
  }
});

test('exchangeCode returns the user token, and maps GitHub’s 200-with-error', async () => {
  const f = fakeFetch([['POST', /^\/login\/oauth\/access_token$/, (_m, body) => (body.code === 'good' ? { access_token: 'ghu_x' } : { error: 'bad_verification_code' })]]);
  const creds = { clientId: 'Iv1.abc', clientSecret: 's' };
  assert.equal(await exchangeCode(creds, 'good', { fetchImpl: f.impl }), 'ghu_x');
  assert.equal(f.calls[0].host, 'github.com');
  assert.equal(await code(() => exchangeCode(creds, 'bad', { fetchImpl: f.impl })), 'unauthorized');
});

/* ── install verification ──────────────────────────────────────────── */

test('the installation must appear among the user’s installations (paginated)', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, account: { login: `o${i}` } }));
  const f = fakeFetch([['GET', /^\/user\/installations\?per_page=100&page=(\d)$/, (m, _b, init) => {
    assert.equal(init.headers.Authorization, 'Bearer ghu_user');
    return { total_count: 101, installations: m[1] === '1' ? page1 : [{ id: 77, account: { login: 'acme' } }] };
  }]]);
  const found = await findUserInstallation('ghu_user', 77, { fetchImpl: f.impl });
  assert.equal(found.account.login, 'acme');
  assert.equal(f.calls.length, 2);
  // Someone passing an installation id they cannot access gets nothing.
  assert.equal(await findUserInstallation('ghu_user', 99999, { fetchImpl: f.impl }), null);
});

test('install state is signed, bound to workspace and user, and expires', () => {
  const signer = { sign: (v) => `mac(${v.length})`, verify: (v, mac) => mac === `mac(${v.length})` };
  const state = makeState(signer, 'ws1', 'u1', 'nonce', 5000);
  assert.deepEqual(readState(signer, state, 4000), { w: 'ws1', u: 'u1', e: 5000, n: 'nonce' });
  assert.equal(readState(signer, state, 6000), null);
  assert.equal(readState(signer, `${state}x`, 4000), null);
  const [payload, mac] = state.split('.');
  const forged = Buffer.from(JSON.stringify({ w: 'ws2', u: 'u1', e: 5000, n: 'nonce' })).toString('base64url');
  assert.equal(readState({ sign: signer.sign, verify: (v, m) => m === mac && v.endsWith(payload) }, `${forged}.${mac}`, 4000), null);
  assert.equal(readState(signer, null), null);
  assert.equal(readState(signer, 'garbage'), null);
});

/* ── validation ────────────────────────────────────────────────────── */

test('theme root normalisation', async () => {
  for (const [input, out] of [['', ''], [undefined, ''], ['/', ''], ['.', ''], ['./theme/', 'theme'], ['/apps/shop/theme', 'apps/shop/theme'], ['My Theme', 'My Theme']]) {
    assert.equal(normaliseThemeRoot(input), out, String(input));
  }
  for (const bad of ['..', 'theme/../secret', 'a//b', '.github', 'x/.git', 'a\\b', 'th€me', 42, 'x'.repeat(201)]) {
    assert.equal(await code(() => normaliseThemeRoot(bad)), 'invalid_input', String(bad));
  }
});

test('owner, repo and branch validation', async () => {
  assert.equal(validateOwner(' acme-co '), 'acme-co');
  assert.equal(validateRepoName('shop.theme_v2'), 'shop.theme_v2');
  assert.equal(validateBranch('feature/new-header'), 'feature/new-header');
  for (const b of ['', 'a..b', 'a b', '-x', 'x/', 'x.lock', 'a@{b', 'a~1', 'a:b', '.hidden', 'a/.b']) assert.equal(await code(() => validateBranch(b)), 'invalid_input', b);
  for (const o of ['', '-x', 'a/b', 'a'.repeat(40)]) assert.equal(await code(() => validateOwner(o)), 'invalid_input', o);
  for (const r of ['', '.', '..', 'a/b', 'a b']) assert.equal(await code(() => validateRepoName(r)), 'invalid_input', r);
});

test('branch names', () => {
  assert.equal(slugify('Add a size guide to product pages!'), 'add-a-size-guide-to-product-pages');
  assert.equal(slugify('Ünïcödé — ✨'), 'unicode');
  assert.equal(slugify('!!!'), 'request');
  assert.ok(slugify('x'.repeat(100)).length <= 40);
  assert.equal(branchName({ number: 12, title: 'Sticky header' }), 'agentify/12-sticky-header');
});

/* ── a fake repository ─────────────────────────────────────────────── */

const b64 = (s) => Buffer.from(s).toString('base64');

/** A repo whose theme lives in "theme/": trees by sha. */
function repoRoutes({ archived = false, themeTree, extraRoot = [] } = {}) {
  const trees = {
    root: { sha: 'root', truncated: false, tree: [
      { path: 'theme', type: 'tree', sha: 'th', mode: '040000' }, { path: 'package.json', type: 'blob', sha: 'pkg', mode: '100644' },
      { path: '.theme-check.yml', type: 'blob', sha: 'tc', mode: '100644' }, { path: 'src', type: 'tree', sha: 'src', mode: '040000' }, ...extraRoot,
    ] },
    th: themeTree ?? { sha: 'th', truncated: false, tree: [
      { path: 'layout', type: 'tree', sha: 'lay' }, { path: 'sections', type: 'tree', sha: 'sec' }, { path: 'templates', type: 'tree', sha: 'tpl' },
    ] },
  };
  const recursive = { sha: 'th', truncated: false, tree: [
    { path: 'layout', type: 'tree', sha: 'lay' }, { path: 'layout/theme.liquid', type: 'blob', sha: 'b1' },
    { path: 'sections', type: 'tree', sha: 'sec' }, { path: 'sections/header.liquid', type: 'blob', sha: 'b2' }, { path: 'sections/footer.liquid', type: 'blob', sha: 'b3' },
    { path: 'templates/index.json', type: 'blob', sha: 'b4' }, { path: 'templates/product.json', type: 'blob', sha: 'b5' },
    { path: 'README.md', type: 'blob', sha: 'b6' },
  ] };
  return [
    ['GET', /^\/repos\/acme\/shop$/, () => ({ name: 'shop', full_name: 'acme/shop', owner: { login: 'acme' }, private: true, archived, default_branch: 'main', html_url: 'https://github.com/acme/shop' })],
    ['GET', /^\/repos\/acme\/shop\/git\/ref\/heads\/main$/, () => ({ ref: 'refs/heads/main', object: { sha: 'c-main', type: 'commit' } })],
    ['GET', /^\/repos\/acme\/shop\/git\/commits\/c-main$/, () => ({ sha: 'c-main', tree: { sha: 'root' } })],
    ['GET', /^\/repos\/acme\/shop\/git\/trees\/th\?recursive=1$/, () => recursive],
    ['GET', /^\/repos\/acme\/shop\/git\/trees\/(\w+)$/, (m) => trees[m[1]] ?? jsonRes(404, { message: 'Not Found' })],
    ['GET', /^\/repos\/acme\/shop\/git\/blobs\/pkg$/, () => ({ encoding: 'base64', content: b64(JSON.stringify({ scripts: { build: 'vite build' }, devDependencies: { tailwindcss: '4' } })) })],
  ];
}

const binding = { owner: 'acme', repo: 'shop', baseBranch: 'main', themeRoot: 'theme' };

test('checkThemeFolder accepts a theme folder and explains what it looked for otherwise', async () => {
  assert.equal(await checkThemeFolder(gh(repoRoutes()).client, binding), null);
  const empty = gh(repoRoutes({ themeTree: { sha: 'th', truncated: false, tree: [{ path: 'docs', type: 'tree', sha: 'd' }] } }));
  const msg = await checkThemeFolder(empty.client, binding);
  assert.match(msg, /layout\/theme\.liquid, sections\/, templates\/, config\/settings_schema\.json/);
  assert.match(msg, /"theme"/);
  assert.equal(await code(() => checkThemeFolder(gh(repoRoutes()).client, { ...binding, themeRoot: 'nope' })), 'not_found');
  assert.equal(await code(() => checkThemeFolder(gh(repoRoutes()).client, { ...binding, baseBranch: 'gone' })), 'not_found');
});

test('listThemeFiles returns theme-relative paths under the root, with a prefix', async () => {
  const { client } = gh(repoRoutes());
  assert.deepEqual(await listThemeFiles(client, binding), ['layout/theme.liquid', 'sections/footer.liquid', 'sections/header.liquid', 'templates/index.json', 'templates/product.json']);
  assert.deepEqual(await listThemeFiles(client, binding, 'sections'), ['sections/footer.liquid', 'sections/header.liquid']);
  assert.match(await code(() => listThemeFiles(client, binding, '../x')), /^other:Theme prefix/);
});

test('listThemeFiles says so when GitHub truncates a folder', async () => {
  const routes = repoRoutes();
  routes.unshift(
    ['GET', /\/git\/trees\/th\?recursive=1$/, () => ({ sha: 'th', truncated: true, tree: [] })],
    ['GET', /\/git\/trees\/sec\?recursive=1$/, () => ({ sha: 'sec', truncated: true, tree: [{ path: 'a.liquid', type: 'blob', sha: 'x' }] })],
    ['GET', /\/git\/trees\/(lay|tpl)\?recursive=1$/, () => ({ sha: 'x', truncated: false, tree: [{ path: 'theme.liquid', type: 'blob', sha: 'y' }] })],
  );
  const out = await listThemeFiles(gh(routes).client, binding);
  assert.ok(out.includes('sections/a.liquid'));
  assert.match(out.at(-1), /truncated the listing of sections\//);
});

test('readThemeFile reads under the root, refuses bad paths, caps long files and describes binaries', async () => {
  const big = 'x'.repeat(70_000);
  const { client, calls } = gh([
    ['GET', /^\/repos\/acme\/shop\/contents\/theme\/sections\/header\.liquid\?ref=main$/, () => ({ type: 'file', encoding: 'base64', content: b64('<header/>'), size: 9, sha: 's' })],
    ['GET', /^\/repos\/acme\/shop\/contents\/theme\/assets\/big\.js\?ref=main$/, () => ({ type: 'file', encoding: 'base64', content: b64(big), size: big.length, sha: 's' })],
    ['GET', /^\/repos\/acme\/shop\/contents\/theme\/assets\/huge\.css\?ref=main$/, () => ({ type: 'file', encoding: 'none', content: '', size: 2e6, sha: 'blobsha' })],
    ['GET', /^\/repos\/acme\/shop\/git\/blobs\/blobsha$/, () => ({ encoding: 'base64', content: b64('body{}') })],
    ['GET', /^\/repos\/acme\/shop\/contents\/theme\/assets\/logo\.png\?ref=main$/, () => ({ type: 'file', encoding: 'base64', content: b64('\x89PNG'), size: 4, sha: 's' })],
    ['GET', /^\/repos\/acme\/shop\/contents\/theme\/assets\/odd\.txt\?ref=main$/, () => ({ type: 'file', encoding: 'base64', content: Buffer.from([1, 0, 2]).toString('base64'), size: 3, sha: 's' })],
  ]);
  assert.equal(await readThemeFile(client, binding, 'sections/header.liquid'), '<header/>');
  assert.match(await readThemeFile(client, binding, 'assets/big.js'), /\[truncated: showing the first 60,000 of 70,000 characters/);
  assert.equal(await readThemeFile(client, binding, 'assets/huge.css'), 'body{}');
  assert.match(await readThemeFile(client, binding, 'assets/logo.png'), /binary file/);
  assert.match(await readThemeFile(client, binding, 'assets/odd.txt'), /binary file/);
  assert.equal(await code(() => readThemeFile(client, binding, 'sections/missing.liquid')), 'not_found');
  for (const bad of ['../secret.liquid', '/etc/passwd', 'sections/../../x.liquid', '.github/workflows/x.yml', 'README.md']) {
    assert.match(await code(() => readThemeFile(client, binding, bad)), /^other:Theme path/, bad);
  }
  assert.ok(calls.every((c) => !c.target.includes('..')));
});

test('repoSummary notes OS 2.0, counts and tooling that changes how files are written', async () => {
  const md = await repoSummary(gh(repoRoutes()).client, binding);
  assert.match(md, /acme\/shop \(private\)/);
  assert.match(md, /Base branch: `main`/);
  assert.match(md, /Theme folder: `theme\/`/);
  assert.match(md, /Online Store 2\.0 \(2 JSON templates\)/);
  assert.match(md, /layout\/ 1, sections\/ 2, templates\/ 2/);
  assert.match(md, /\.theme-check\.yml/);
  assert.match(md, /`build`: `vite build`/);
  assert.match(md, /tailwindcss/);
  assert.match(md, /a build step/);
  assert.match(md, /src\//);
});

/* ── pull requests ─────────────────────────────────────────────────── */

const baseTask = {
  id: 't', number: 7, title: 'Size guide', workspaceId: 'w', storeId: 's',
  brief: { title: 'Size guide', summary: 'A size guide drawer.', goals: [], userStories: [], acceptanceCriteria: ['Opens from the product page', 'Closes on Escape'], outOfScope: [] },
  feasibility: { verdict: 'clear', approach: '', surfaces: [], blockers: [], edgeCases: ['Products without sizes'], questions: [] },
  review: { verdict: 'pass', checks: [{ criterion: 'Opens from the product page', pass: true, note: '' }, { criterion: 'Closes on Escape', pass: false, note: 'Esc ignored' }], issues: [] },
  build: { round: 1, summary: 'Adds a drawer.', installNotes: 'Add the section to the product template.', checks: [{ severity: 'warning', check: 'UnusedAssign', message: 'x unused', path: 'sections/size-guide.liquid', line: 3 }],
    files: [{ path: 'sections/size-guide.liquid', content: '<div>guide</div>' }, { path: 'assets/size-guide.css', content: '.g{}' }] },
  pullRequest: null,
};

/** The write side of a fake repo: records blobs, trees, commits and refs. */
function writeRoutes(state) {
  return [
    ['GET', /^\/repos\/acme\/shop\/pulls\?state=all&per_page=20&head=acme%3A(.+)$/, (m) => state.pulls.filter((p) => p.head.ref === decodeURIComponent(m[1]))],
    ['GET', /^\/repos\/acme\/shop\/git\/ref\/heads\/(agentify\/.+)$/, (m) => (state.refs[m[1]] ? { ref: `refs/heads/${m[1]}`, object: { sha: state.refs[m[1]], type: 'commit' } } : jsonRes(404, { message: 'Not Found' }))],
    ['GET', /^\/repos\/acme\/shop\/git\/commits\/(c-\w+)$/, (m) => ({ sha: m[1], tree: { sha: m[1] === 'c-main' ? 'root' : `tree-of-${m[1]}` } })],
    ['POST', /^\/repos\/acme\/shop\/git\/blobs$/, (_m, body) => { state.blobs.push(body); return jsonRes(201, { sha: `blob${state.blobs.length}` }); }],
    ['POST', /^\/repos\/acme\/shop\/git\/trees$/, (_m, body) => { state.trees.push(body); return jsonRes(201, { sha: state.sameTree ? body.base_tree : `tree${state.trees.length}` }); }],
    ['POST', /^\/repos\/acme\/shop\/git\/commits$/, (_m, body) => { state.commits.push(body); return jsonRes(201, { sha: `c-new${state.commits.length}` }); }],
    ['POST', /^\/repos\/acme\/shop\/git\/refs$/, (_m, body) => {
      if (state.protect) return jsonRes(422, { message: 'Repository rule violations found', errors: ['Cannot create ref due to creations being restricted.'] });
      if (body.ref === 'refs/heads/main') throw new Error('wrote base branch');
      state.refs[body.ref.replace('refs/heads/', '')] = body.sha; state.created.push(body); return jsonRes(201, {});
    }],
    ['PATCH', /^\/repos\/acme\/shop\/git\/refs\/heads\/(.+)$/, (m, body) => {
      if (m[1] === 'main') throw new Error('wrote base branch');
      state.updated.push({ branch: m[1], ...body }); state.refs[m[1]] = body.sha; return {};
    }],
    ['GET', /^\/repos\/acme\/shop\/pulls\/(\d+)\/files/, () => state.prFiles ?? []],
    ['GET', /^\/repos\/acme\/shop\/git\/trees\/root\?recursive=1$/, () => ({ sha: 'root', truncated: false, tree: [{ path: 'theme/assets/old.css', type: 'blob', sha: 'oldsha' }] })],
    ['PATCH', /^\/repos\/acme\/shop\/pulls\/(\d+)$/, (m, body) => { state.patchedPulls.push({ number: Number(m[1]), ...body }); return {}; }],
    ['POST', /^\/repos\/acme\/shop\/pulls$/, (_m, body) => {
      if (state.denyPulls) return jsonRes(403, { message: 'Resource not accessible by integration' }, { 'x-accepted-github-permissions': 'pull_requests=write' });
      state.opened.push(body); return jsonRes(201, { number: 31, html_url: 'https://github.com/acme/shop/pull/31', state: 'open', merged_at: null, head: { ref: body.head } });
    }],
  ];
}

const fresh = (patch = {}) => ({ pulls: [], refs: {}, blobs: [], trees: [], commits: [], created: [], updated: [], patchedPulls: [], opened: [], ...patch });

test('a first PR: one commit with every file under the theme root, a new branch from the base tip, and a full body', async () => {
  const state = fresh();
  const { client } = gh([...writeRoutes(state), ...repoRoutes()]);
  const pr = await openOrUpdatePull(client, binding, structuredClone(baseTask), 1000);
  assert.deepEqual(pr, { status: 'opened', at: 1000, url: 'https://github.com/acme/shop/pull/31', number: 31, branch: 'agentify/7-size-guide' });
  assert.equal(state.trees.length, 1);
  assert.equal(state.trees[0].base_tree, 'root');
  assert.deepEqual(state.trees[0].tree.map((e) => e.path), ['theme/sections/size-guide.liquid', 'theme/assets/size-guide.css']);
  assert.deepEqual(state.blobs.map((b) => b.content), ['<div>guide</div>', '.g{}']);
  assert.equal(state.commits.length, 1);
  assert.deepEqual(state.commits[0].parents, ['c-main']);
  assert.deepEqual(state.created, [{ ref: 'refs/heads/agentify/7-size-guide', sha: 'c-new1' }]);
  assert.equal(state.opened[0].base, 'main');
  const body = state.opened[0].body;
  assert.match(body, /- \[x\] Opens from the product page/);
  assert.match(body, /- \[ \] Closes on Escape/);
  assert.match(body, /Products without sizes/);
  assert.match(body, /Add the section to the product template/);
  assert.match(body, /Verdict: \*\*pass\*\*/);
  assert.match(body, /UnusedAssign/);
  assert.match(body, /Opened by Agentify for request #7/);
});

test('a rework adds a commit on the same branch (fast-forward only) and reports updated; dropped files go back to base', async () => {
  const state = fresh({
    pulls: [{ number: 31, html_url: 'https://github.com/acme/shop/pull/31', state: 'open', merged_at: null, head: { ref: 'agentify/7-size-guide' } }],
    refs: { 'agentify/7-size-guide': 'c-prev' },
    prFiles: [{ filename: 'theme/sections/size-guide.liquid' }, { filename: 'theme/assets/old.css' }, { filename: 'theme/snippets/gone.liquid' }],
  });
  const task = structuredClone(baseTask);
  task.build.round = 2;
  task.pullRequest = { status: 'opened', at: 1, number: 31, branch: 'agentify/7-size-guide', url: 'u' };
  const { client } = gh([...writeRoutes(state), ...repoRoutes()]);
  const pr = await openOrUpdatePull(client, binding, task, 2000);
  assert.equal(pr.status, 'updated');
  assert.equal(pr.branch, 'agentify/7-size-guide');
  assert.equal(pr.number, 31);
  assert.equal(state.trees[0].base_tree, 'tree-of-c-prev');
  assert.deepEqual(state.commits[0].parents, ['c-prev']);
  assert.match(state.commits[0].message, /round 2/);
  assert.deepEqual(state.updated, [{ branch: 'agentify/7-size-guide', sha: 'c-new1', force: false }]);
  assert.equal(state.created.length, 0);
  assert.equal(state.opened.length, 0);
  assert.equal(state.patchedPulls[0].number, 31);
  const restore = state.trees[0].tree.filter((e) => e.path === 'theme/assets/old.css' || e.path === 'theme/snippets/gone.liquid');
  assert.deepEqual(restore.map((e) => e.sha), ['oldsha', null]);
});

test('after the earlier PR was merged, a fresh branch name and a new PR', async () => {
  const state = fresh({
    pulls: [{ number: 31, html_url: 'x', state: 'closed', merged_at: '2026-01-01', head: { ref: 'agentify/7-size-guide' } }],
    refs: { 'agentify/7-size-guide': 'c-prev' },
  });
  const task = structuredClone(baseTask);
  task.pullRequest = { status: 'opened', at: 1, number: 31, branch: 'agentify/7-size-guide', url: 'x' };
  const { client } = gh([...writeRoutes(state), ...repoRoutes()]);
  const pr = await openOrUpdatePull(client, binding, task, 3000);
  assert.equal(pr.status, 'opened');
  assert.equal(pr.branch, 'agentify/7-size-guide-2');
  assert.deepEqual(state.commits[0].parents, ['c-main']);
  assert.deepEqual(state.created, [{ ref: 'refs/heads/agentify/7-size-guide-2', sha: 'c-new1' }]);
  assert.equal(state.updated.length, 0);
});

test('model-written paths are re-validated before anything is written', async () => {
  for (const path of ['../../.github/workflows/x.yml', '/etc/passwd', 'sections/../../x.liquid', 'README.md']) {
    const state = fresh();
    const task = structuredClone(baseTask);
    task.build.files = [{ path, content: 'x' }];
    const pr = await openOrUpdatePull(gh([...writeRoutes(state), ...repoRoutes()]).client, binding, task, 1);
    assert.equal(pr.status, 'failed', path);
    assert.match(pr.error, /not allowed/);
    assert.equal(state.blobs.length + state.trees.length + state.created.length, 0);
  }
});

test('failures come back as actionable messages, not throws', async () => {
  // Missing permission → which one.
  let pr = await openOrUpdatePull(gh([...writeRoutes(fresh({ denyPulls: true })), ...repoRoutes()]).client, binding, structuredClone(baseTask), 1);
  assert.equal(pr.status, 'failed');
  assert.match(pr.error, /missing a permission .* Pull requests: write/);
  // Branch protection / rulesets.
  pr = await openOrUpdatePull(gh([...writeRoutes(fresh({ protect: true })), ...repoRoutes()]).client, binding, structuredClone(baseTask), 1);
  assert.match(pr.error, /branch protection rule or ruleset .* agentify\/\*/);
  // Archived.
  pr = await openOrUpdatePull(gh([...writeRoutes(fresh()), ...repoRoutes({ archived: true })]).client, binding, structuredClone(baseTask), 1);
  assert.match(pr.error, /archived/);
  // Installation removed.
  const f = fakeFetch([]);
  const client = installationClient(tokenCache({ appId: '1', privateKey: PKCS1 }, { fetchImpl: f.impl, wait: noWait }), 42, { fetchImpl: f.impl, wait: noWait });
  pr = await openOrUpdatePull(client, binding, structuredClone(baseTask), 1);
  assert.match(pr.error, /no longer installed/);
  // Repo no longer visible.
  pr = await openOrUpdatePull(gh(writeRoutes(fresh())).client, binding, structuredClone(baseTask), 1);
  assert.match(pr.error, /cannot see acme\/shop/);
  // Base branch deleted.
  pr = await openOrUpdatePull(gh([...writeRoutes(fresh()), ...repoRoutes()]).client, { ...binding, baseBranch: 'gone' }, structuredClone(baseTask), 1);
  assert.match(pr.error, /base branch "gone" no longer exists/);
  // Identical to base.
  pr = await openOrUpdatePull(gh([...writeRoutes(fresh({ sameTree: true })), ...repoRoutes()]).client, binding, structuredClone(baseTask), 1);
  assert.match(pr.error, /identical to main/);
});

test('prBody survives a task with no brief or review', () => {
  const body = prBody({ ...baseTask, brief: null, review: null, feasibility: null, build: { ...baseTask.build, checks: null } });
  assert.match(body, /could not run/);
  assert.match(body, /request #7/);
});
