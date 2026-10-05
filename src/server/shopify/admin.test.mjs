/**
 * Checks for admin.ts and oauth.ts against a mocked fetch: domain/token/path
 * validation, throttle retries and error mapping, and the OAuth pieces
 * (callback HMAC, signed state, shop checks, token exchange and refresh).
 * No network, no store needed.
 *
 *   node --experimental-strip-types --test src/server/shopify/admin.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  API_VERSION, ShopifyError, adminClient, normaliseDomain, normaliseToken, validateThemePath, validateThemePrefix,
} from './admin.ts';
import {
  STATE_TTL_MS, TokenError, authorizeUrl, decodeState, encodeState, exchangeCode, isShopHostname, parseTokenResponse,
  refreshTokens, verifyCallbackHmac,
} from './oauth.ts';
import { createHmac } from 'node:crypto';

// A made-up token, assembled here so secret scanners do not mistake the fixture for a real one.
const FAKE_TOKEN = `shpat_${'0123456789abcdef'.repeat(2)}`;

const code = (fn) => { try { fn(); } catch (e) { return e instanceof ShopifyError ? e.code : `other:${e}`; } return 'ok'; };

test('normaliseDomain accepts the forms merchants paste', () => {
  for (const input of ['my-store', 'My-Store.myshopify.com', ' https://my-store.myshopify.com/admin/products ', 'http://my-store.myshopify.com', 'https://admin.shopify.com/store/my-store/themes', 'my-store.myshopify.com/']) {
    assert.equal(normaliseDomain(input), 'my-store.myshopify.com', input);
  }
  // A bare word is a store handle; it can only ever resolve under myshopify.com.
  assert.equal(normaliseDomain('localhost'), 'localhost.myshopify.com');
});

test('normaliseDomain rejects anything that is not <handle>.myshopify.com', () => {
  for (const input of [
    'shop.example.com', 'example.com', 'my-store.myshopify.com.evil.com', 'evil.com/my-store.myshopify.com',
    'my-store.myshopify.com:8080', 'user@my-store.myshopify.com', 'a.b.myshopify.com', '169.254.169.254',
    '-store.myshopify.com', 'store-.myshopify.com', 'my_store.myshopify.com', '', '   ', 42, null, 'x'.repeat(300),
    'my store', '%2e%2e.myshopify.com', 'my-store.myshopify.com\\@evil.com', 'xn--.myshopify.com.', '.myshopify.com',
  ]) {
    assert.equal(code(() => normaliseDomain(input)), 'invalid_domain', String(input));
  }
});

test('normaliseToken', () => {
  assert.equal(normaliseToken(` ${FAKE_TOKEN} `), FAKE_TOKEN);
  assert.equal(code(() => normaliseToken('0123456789abcdef0123456789abcdef')), 'invalid_token');
  assert.match((() => { try { normaliseToken('0123456789abcdef0123456789abcdef'); } catch (e) { return e.message; } })(), /API key or secret/);
  for (const bad of ['', 'shpat_', 'shpat_abc', 'Bearer shpat_0123456789abcdef0123', 'shpat_0123456789abcdef\n0123', undefined]) {
    assert.equal(code(() => normaliseToken(bad)), 'invalid_token', String(bad));
  }
});

test('validateThemePath', () => {
  for (const ok of ['sections/size-guide.liquid', 'templates/customers/account.json', 'assets/app.min.js', 'config/settings_schema.json', 'blocks/_card.liquid', 'locales/en.default.json']) {
    assert.equal(validateThemePath(ok), ok);
  }
  for (const bad of ['../secrets', 'sections/../layout/theme.liquid', '/sections/x.liquid', 'secrets/x.liquid', 'sections/', 'sections', 'sections/x', 'sections//x.liquid', 'sections/x y.liquid', 'sections/*.liquid', 'sections\\x.liquid', 'https://evil.com/x.js', '', null, `sections/${'a'.repeat(250)}.liquid`, 'sections/./x.liquid']) {
    assert.equal(code(() => validateThemePath(bad)), 'invalid_path', String(bad));
  }
});

test('validateThemePrefix', () => {
  assert.equal(validateThemePrefix(undefined), '');
  assert.equal(validateThemePrefix(''), '');
  assert.equal(validateThemePrefix('sections'), 'sections/');
  assert.equal(validateThemePrefix('sections/'), 'sections/');
  assert.equal(validateThemePrefix('snippets/card-'), 'snippets/card-');
  assert.equal(validateThemePrefix('templates/customers'), 'templates/customers');
  for (const bad of ['..', 'sections/..', '/sections', 'secret/', 'sections/*', 'sections//', 42]) {
    assert.equal(code(() => validateThemePrefix(bad)), 'invalid_path', String(bad));
  }
});

/* ── client ── */

const jsonResponse = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function mockFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected call');
    return typeof next === 'function' ? next() : next;
  };
  return { calls, fetchImpl };
}

const waits = [];
const wait = async (ms) => { waits.push(ms); };
const TOKEN = FAKE_TOKEN;

test('client posts to the pinned version on the validated domain without following redirects', async () => {
  const { calls, fetchImpl } = mockFetch([jsonResponse({ data: { shop: { name: 'S' } } })]);
  const client = adminClient('My-Store', TOKEN, { fetchImpl, wait });
  const data = await client.query('query { shop { name } }');
  assert.deepEqual(data, { shop: { name: 'S' } });
  assert.equal(calls[0].url, `https://my-store.myshopify.com/admin/api/${API_VERSION}/graphql.json`);
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.headers['X-Shopify-Access-Token'], TOKEN);
});

test('client refuses to be built for a bad domain', () => {
  assert.equal(code(() => adminClient('evil.com', TOKEN)), 'invalid_domain');
});

test('client retries GraphQL THROTTLED using the throttle status, then succeeds', async () => {
  waits.length = 0;
  const throttled = jsonResponse({
    errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
    extensions: { cost: { requestedQueryCost: 300, throttleStatus: { currentlyAvailable: 100, restoreRate: 100 } } },
  });
  const { calls, fetchImpl } = mockFetch([throttled, jsonResponse({ data: { ok: true } })]);
  assert.deepEqual(await adminClient('s', TOKEN, { fetchImpl, wait }).query('q'), { ok: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [2000]);
});

test('client retries HTTP 429 honouring Retry-After, and gives up after 4 attempts', async () => {
  waits.length = 0;
  const r429 = () => jsonResponse({ errors: 'Exceeded' }, 429, { 'retry-after': '2' });
  const { calls, fetchImpl } = mockFetch([r429, r429, r429, r429]);
  await assert.rejects(adminClient('s', TOKEN, { fetchImpl, wait }).query('q'), (e) => e.code === 'throttled');
  assert.equal(calls.length, 4);
  assert.deepEqual(waits, [2000, 2000, 2000]);
});

test('client maps HTTP statuses to codes and never leaks the token', async () => {
  const cases = [[401, 'token_rejected'], [403, 'access_denied'], [404, 'store_not_found'], [301, 'store_not_found'], [402, 'store_unavailable'], [423, 'store_unavailable'], [400, 'shopify_error']];
  for (const [status, expected] of cases) {
    const { fetchImpl } = mockFetch([new Response('{}', { status })]);
    await assert.rejects(adminClient('s', TOKEN, { fetchImpl, wait }).query('q'), (e) => {
      assert.equal(e.code, expected, String(status));
      assert.ok(!e.message.includes(TOKEN));
      return true;
    });
  }
});

test('client surfaces ACCESS_DENIED and other GraphQL errors', async () => {
  let { fetchImpl } = mockFetch([jsonResponse({ errors: [{ message: 'Access denied for themes field.', extensions: { code: 'ACCESS_DENIED' } }] })]);
  await assert.rejects(adminClient('s', TOKEN, { fetchImpl, wait }).query('q'), (e) => e.code === 'access_denied' && /themes/.test(e.message));
  ({ fetchImpl } = mockFetch([jsonResponse({ errors: [{ message: 'Field x does not exist' }] })]));
  await assert.rejects(adminClient('s', TOKEN, { fetchImpl, wait }).query('q'), (e) => e.code === 'shopify_error');
});

test('client retries network errors and 5xx', async () => {
  waits.length = 0;
  const { calls, fetchImpl } = mockFetch([() => { throw new TypeError('fetch failed'); }, new Response('', { status: 503 }), jsonResponse({ data: { ok: 1 } })]);
  assert.deepEqual(await adminClient('s', TOKEN, { fetchImpl, wait }).query('q'), { ok: 1 });
  assert.equal(calls.length, 3);
});

/* ── OAuth ── */

const SECRET = 'hush';
const signQuery = (params, secret = SECRET) => {
  const message = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  return createHmac('sha256', secret).update(message).digest('hex');
};

test('verifyCallbackHmac matches Shopify\'s documented example', () => {
  // The worked example from Shopify's earlier OAuth docs (client secret "hush"); the current page shows the same algorithm in code.
  const q = new URLSearchParams('code=0907a61c0c8d55e99db179b68161bc00&hmac=700e2dadb827fcc8609e9d5ce208b2e9cdaab9df07390d2cbca10d7c328fc4bf&shop=some-shop.myshopify.com&state=0.6784241404160823&timestamp=1337178173');
  assert.equal(verifyCallbackHmac(q, 'hush'), true);
});

test('verifyCallbackHmac accepts a correct signature over any parameter order and rejects tampering', () => {
  const base = { code: 'abc123', shop: 'my-store.myshopify.com', state: 'xyz.mac_-', timestamp: '1700000000', host: 'YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvbXktc3RvcmU' };
  const hmac = signQuery(base);
  const q = new URLSearchParams({ timestamp: base.timestamp, hmac, shop: base.shop, host: base.host, code: base.code, state: base.state });
  assert.equal(verifyCallbackHmac(q, SECRET), true);
  for (const [k, v] of [['shop', 'evil.myshopify.com'], ['code', 'other'], ['state', 'x'], ['timestamp', '1']]) {
    const t = new URLSearchParams(q); t.set(k, v);
    assert.equal(verifyCallbackHmac(t, SECRET), false, k);
  }
  const extra = new URLSearchParams(q); extra.set('admin', '1');
  assert.equal(verifyCallbackHmac(extra, SECRET), false, 'added param');
  assert.equal(verifyCallbackHmac(q, 'wrong'), false, 'wrong secret');
  const noHmac = new URLSearchParams(q); noHmac.delete('hmac');
  assert.equal(verifyCallbackHmac(noHmac, SECRET), false, 'missing hmac');
  const short = new URLSearchParams(q); short.set('hmac', hmac.slice(0, 10));
  assert.equal(verifyCallbackHmac(short, SECRET), false, 'truncated hmac');
  assert.equal(verifyCallbackHmac(q, ''), false, 'empty secret');
});

test('isShopHostname is Shopify\'s anchored check', () => {
  for (const ok of ['my-store.myshopify.com', 'A1.myshopify.com']) assert.equal(isShopHostname(ok), true, ok);
  for (const bad of ['my-store.myshopify.com.attacker.example', 'evil.com', '-x.myshopify.com', 'a.b.myshopify.com', 'my-store.myshopify.com/', '', null, 42]) {
    assert.equal(isShopHostname(bad), false, String(bad));
  }
});

test('authorizeUrl targets only a validated shop and carries the documented parameters', () => {
  const u = new URL(authorizeUrl({ shop: 'My-Store', clientId: 'cid', scopes: 'read_themes,write_themes', redirectUri: 'https://agentify.plus/api/shopify/oauth/callback', state: 's.m' }));
  assert.equal(u.origin, 'https://my-store.myshopify.com');
  assert.equal(u.pathname, '/admin/oauth/authorize');
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('scope'), 'read_themes,write_themes');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://agentify.plus/api/shopify/oauth/callback');
  assert.equal(u.searchParams.get('state'), 's.m');
  assert.equal(u.searchParams.has('grant_options[]'), false, 'offline token, not per-user');
  assert.equal(code(() => authorizeUrl({ shop: 'evil.com', clientId: 'c', scopes: 's', redirectUri: 'r', state: 's' })), 'invalid_domain');
});

test('state round-trips, and is refused when forged, tampered or expired', () => {
  const key = 'k';
  const sign = (v) => createHmac('sha256', key).update(v).digest('base64url');
  const verify = (v, mac) => sign(v) === mac;
  const now = 1_700_000_000_000;
  const st = { workspaceId: 'w1', storeId: 's1', shop: 'my-store.myshopify.com', nonce: 'n'.repeat(32), exp: now + STATE_TTL_MS };
  const raw = encodeState(st, sign);
  assert.deepEqual(decodeState(raw, verify, now), st);
  assert.equal(decodeState(raw, verify, now + STATE_TTL_MS + 1), null, 'expired');
  const [body, mac] = raw.split('.');
  const other = Buffer.from(JSON.stringify({ ...st, storeId: 's2' })).toString('base64url');
  assert.equal(decodeState(`${other}.${mac}`, verify, now), null, 'body swapped');
  assert.equal(decodeState(`${body}.${mac.slice(1)}`, verify, now), null, 'mac changed');
  assert.equal(decodeState(`${body}.`, verify, now), null);
  assert.equal(decodeState(body, verify, now), null);
  assert.equal(decodeState(undefined, verify, now), null);
  const junk = Buffer.from('not json').toString('base64url');
  assert.equal(decodeState(`${junk}.${sign(junk)}`, verify, now), null, 'signed junk');
  const partial = Buffer.from(JSON.stringify({ workspaceId: 'w1', exp: now + 1000 })).toString('base64url');
  assert.equal(decodeState(`${partial}.${sign(partial)}`, verify, now), null, 'missing fields');
});

test('parseTokenResponse keeps expiry only alongside a refresh token', () => {
  const now = 1_000_000;
  assert.deepEqual(parseTokenResponse({ access_token: 'shpat_x', scope: 'write_themes,read_products', expires_in: 3600, refresh_token: 'shprt_y', refresh_token_expires_in: 7776000 }, now), {
    accessToken: 'shpat_x', scopes: ['read_products', 'write_themes'], expiresAt: now + 3_600_000, refreshToken: 'shprt_y', refreshExpiresAt: now + 7_776_000_000,
  });
  const nonExpiring = parseTokenResponse({ access_token: 'f85632530bf277ec9ac6f649fc327f17', scope: 'read_themes', expires_in: 3600 }, now);
  assert.equal(nonExpiring.expiresAt, null);
  assert.equal(nonExpiring.refreshToken, null);
  assert.throws(() => parseTokenResponse({ scope: 'x' }), (e) => e.code === 'shopify_error');
  assert.throws(() => parseTokenResponse({ access_token: 'a b' }), (e) => e.code === 'shopify_error');
});

const APP = { clientId: 'cid', clientSecret: 'csecret' };

test('exchangeCode posts the documented form (with expiring=1) to the validated shop without following redirects', async () => {
  const { calls, fetchImpl } = mockFetch([jsonResponse({ access_token: 'shpat_a', scope: 'read_themes,write_themes', expires_in: 3600, refresh_token: 'shprt_r', refresh_token_expires_in: 7776000 })]);
  const tokens = await exchangeCode('my-store.myshopify.com', 'the-code', APP, { fetchImpl, now: 0 });
  assert.equal(calls[0].url, 'https://my-store.myshopify.com/admin/oauth/access_token');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].init.body)), { client_id: 'cid', client_secret: 'csecret', code: 'the-code', expiring: '1' });
  assert.equal(tokens.accessToken, 'shpat_a');
  assert.equal(tokens.expiresAt, 3_600_000);
  await assert.rejects(exchangeCode('evil.com', 'c', APP, { fetchImpl }), (e) => e.code === 'invalid_domain');
});

test('refreshTokens sends grant_type=refresh_token and classifies failures', async () => {
  let { calls, fetchImpl } = mockFetch([jsonResponse({ access_token: 'shpat_b', expires_in: 3600, refresh_token: 'shprt_s', refresh_token_expires_in: 7776000, scope: 'write_themes' })]);
  const t = await refreshTokens('my-store.myshopify.com', 'shprt_r', APP, { fetchImpl, now: 0 });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].init.body)), { client_id: 'cid', client_secret: 'csecret', grant_type: 'refresh_token', refresh_token: 'shprt_r' });
  assert.equal(t.refreshToken, 'shprt_s');

  const cases = [
    [() => jsonResponse({ error: 'invalid_request' }, 401), true],
    [() => jsonResponse({ error: 'invalid_grant' }, 400), true],
    [() => jsonResponse({ error: 'invalid_client' }, 400), false],
    [() => new Response('', { status: 503 }), false],
    [() => { throw new TypeError('fetch failed'); }, false],
  ];
  for (const [res, terminal] of cases) {
    ({ fetchImpl } = mockFetch([res]));
    await assert.rejects(refreshTokens('s', 'shprt_r', APP, { fetchImpl }), (e) => {
      assert.ok(e instanceof TokenError);
      assert.equal(e.terminal, terminal);
      assert.ok(!e.message.includes('csecret') && !e.message.includes('shprt_r'));
      return true;
    });
  }
});
