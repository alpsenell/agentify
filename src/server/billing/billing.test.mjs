/**
 * Plans, usage and Stripe, against an in-memory store and a mocked fetch.
 *
 *   node --experimental-strip-types --test src/server/billing/billing.test.mjs
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { memoryStore } from '../testing/memory-store.mjs';
import { PLANS, displayPrice, formatTokens } from '../../agency/plans.ts';
import { addMonth, addUsage, compact, currentPlan, memberDenial, planDenial, readUsage, runDenial, storeDenial } from './usage.ts';
import {
  STRIPE_API_VERSION, applySubscription, billingKey, checkoutUrl, formEncode, handleEvent, planFromSubscription, signPayload, verifySignature,
} from './stripe.ts';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 31, 12); // Jan 31, to exercise month-end clamping

const workspace = (plan = {}, extra = {}) => ({
  id: 'ws-1', name: 'Northwind', notes: '', stores: [], github: null, taskSeq: 0, createdAt: T0,
  plan: { tier: 'pilot', status: 'active', periodStart: T0, periodEnd: addMonth(T0), ...plan }, ...extra,
});

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/* ── plans ─────────────────────────────────────────────────────────── */

test('plan table: ceilings keep worst-case model cost under ~15% of the price', () => {
  const worstPerToken = 7.2 / 1e6; // 80% input at $4/M, 20% output at $20/M
  for (const tier of ['pilot', 'team']) {
    const price = Number(displayPrice(tier).price.replace(/[$,]/g, ''));
    assert.ok(price > 0, tier);
    assert.ok(PLANS[tier].tokenLimit * worstPerToken <= price * 0.16, `${tier} ceiling too high`);
    assert.ok(PLANS[tier].purchasable);
  }
  assert.equal(displayPrice('studio').price, '');
  assert.equal(PLANS.studio.purchasable, false);
  assert.equal(formatTokens(2_500_000), '2.5M');
  assert.equal(formatTokens(40_000_000), '40M');
});

/* ── periods ───────────────────────────────────────────────────────── */

test('addMonth keeps the anchor day and clamps short months', () => {
  const feb = addMonth(T0);
  assert.equal(new Date(feb).toISOString(), '2026-02-28T12:00:00.000Z');
  assert.equal(new Date(addMonth(feb, 31)).toISOString(), '2026-03-31T12:00:00.000Z');
});

test('paid plans roll over monthly; the trial and cancelled plans do not', () => {
  const now = T0 + 70 * DAY; // ~Apr 11
  const rolled = currentPlan(workspace().plan, now);
  assert.equal(new Date(rolled.periodStart).toISOString(), '2026-03-31T12:00:00.000Z');
  assert.equal(new Date(rolled.periodEnd).toISOString(), '2026-04-30T12:00:00.000Z');
  const trial = { tier: 'trial', status: 'trialing', periodStart: T0, periodEnd: T0 + 14 * DAY };
  assert.deepEqual(currentPlan(trial, now), trial);
  const canceled = { ...workspace().plan, status: 'canceled' };
  assert.deepEqual(currentPlan(canceled, now), canceled);
});

/* ── usage ─────────────────────────────────────────────────────────── */

test('concurrent steps never lose an increment', async () => {
  const kv = memoryStore();
  const ws = workspace();
  await Promise.all(Array.from({ length: 25 }, (_, i) => addUsage(kv, ws, { input: 1000 + i, output: 10 }, { now: T0 + 1000 })));
  const usage = await readUsage(kv, ws, { now: T0 + 2000 });
  assert.equal(usage.steps, 25);
  assert.equal(usage.tokens, 25 * 1010 + (24 * 25) / 2);
  assert.equal(usage.tokenLimit, PLANS.pilot.tokenLimit);
});

test('compaction folds records, keeps totals exact, and survives racing writers and a crash', async () => {
  const kv = memoryStore();
  const ws = workspace();
  // 100 concurrent steps: several compactions trigger while others are still writing.
  await Promise.all(Array.from({ length: 100 }, () => addUsage(kv, ws, { input: 7, output: 3 }, { now: T0 + 1000 })));
  let usage = await readUsage(kv, ws, { now: T0 + 2000 });
  assert.deepEqual([usage.tokens, usage.steps], [1000, 100]);
  assert.ok([...kv.data.keys()].filter((k) => k.startsWith('usage:')).length < 100, 'records were compacted');

  // A compactor that wrote its summary but died before deleting anything must not double count.
  const prefix = `usage:${ws.id}:${ws.plan.periodStart}:`;
  const realDelete = kv.delete;
  kv.delete = async (key) => { if (key.startsWith('usage:')) throw new Error('crash'); return realDelete(key); };
  await assert.rejects(compact(kv, ws.id, prefix, T0 + 3000, 1));
  kv.delete = realDelete;
  await kv.delete(`usage-lock:${ws.id}`);
  usage = await readUsage(kv, ws, { now: T0 + 4000 });
  assert.deepEqual([usage.tokens, usage.steps], [1000, 100]);
  // And a later compaction cleans the leftovers up.
  assert.equal(await compact(kv, ws.id, prefix, T0 + 5000, 1), true);
  usage = await readUsage(kv, ws, { now: T0 + 6000 });
  assert.deepEqual([usage.tokens, usage.steps], [1000, 100]);
  assert.equal([...kv.data.keys()].filter((k) => k.startsWith(prefix)).length, 1);
});

test('a new period starts from zero', async () => {
  const kv = memoryStore();
  const ws = workspace();
  await addUsage(kv, ws, { input: 500, output: 500 }, { now: T0 + DAY });
  assert.equal((await readUsage(kv, ws, { now: T0 + 2 * DAY })).tokens, 1000);
  const next = T0 + 40 * DAY; // past Feb 28
  assert.equal((await readUsage(kv, ws, { now: next })).tokens, 0);
  await addUsage(kv, ws, { input: 1, output: 1 }, { now: next });
  assert.deepEqual(await readUsage(kv, ws, { now: next + 1 }), { tokens: 2, steps: 1, tokenLimit: PLANS.pilot.tokenLimit });
});

test('overrides: a lower ceiling and a minimum per step (for the scripted model)', async () => {
  const kv = memoryStore();
  const ws = workspace();
  await addUsage(kv, ws, { input: 0, output: 0 }, { now: T0 + 1, minStepTokens: 600 });
  const usage = await readUsage(kv, ws, { now: T0 + 2, tokenLimit: 1000 });
  assert.deepEqual(usage, { tokens: 600, steps: 1, tokenLimit: 1000 });
});

/* ── limits ────────────────────────────────────────────────────────── */

test('runDenial: ceiling, ended trial, cancelled plan', () => {
  const ws = workspace();
  assert.equal(runDenial(ws, { tokens: 10, tokenLimit: 100, steps: 1 }, T0 + DAY), null);
  const limit = runDenial(ws, { tokens: 100, tokenLimit: 100, steps: 9 }, T0 + DAY);
  assert.equal(limit.code, 'plan_limit');
  assert.match(limit.message, /Settings → Plan/);
  assert.match(limit.message, /renews on February 28/);

  const trial = workspace({ tier: 'trial', status: 'trialing', periodEnd: T0 + 14 * DAY });
  assert.equal(runDenial(trial, { tokens: 0, tokenLimit: 100, steps: 0 }, T0 + DAY), null);
  const ended = runDenial(trial, { tokens: 0, tokenLimit: 100, steps: 0 }, T0 + 15 * DAY);
  assert.equal(ended.code, 'plan_inactive');
  assert.match(ended.message, /trial ended on February 14/);
  assert.match(runDenial(trial, { tokens: 100, tokenLimit: 100, steps: 0 }, T0 + DAY).message, /does not renew/);

  assert.equal(planDenial(workspace({ status: 'canceled' }).plan, T0).code, 'plan_inactive');
  assert.equal(planDenial(workspace({ status: 'past_due' }).plan, T0), null, 'past due keeps working while Stripe retries');
});

test('store and seat limits', () => {
  const store = (id) => ({ id, label: id, env: 'production', shopify: null, repo: null, createdAt: T0 });
  assert.equal(storeDenial(workspace({}, { stores: [store('a')] })), null);
  const full = storeDenial(workspace({}, { stores: [store('a'), store('b')] }));
  assert.equal(full.code, 'plan_limit');
  assert.match(full.message, /Pilot plan includes 2 stores/);
  assert.equal(storeDenial(workspace({ tier: 'trial' }, { stores: [store('a')] })).code, 'plan_limit');
  assert.equal(memberDenial(workspace(), 2), null);
  assert.match(memberDenial(workspace(), 3).message, /3 seats/);
});

/* ── Stripe signatures ─────────────────────────────────────────────── */

const SECRET = 'whsec_test_secret';
const body = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated' });

test('a valid signature verifies, including with a second (rolled) v1 and a v0', () => {
  const now = 1_790_000_000;
  const header = signPayload(body, SECRET, now);
  assert.equal(verifySignature(body, header, SECRET, now), true);
  const sig = createHmac('sha256', SECRET).update(`${now}.${body}`).digest('hex');
  assert.equal(verifySignature(body, `t=${now},v1=${'0'.repeat(64)},v1=${sig},v0=abc`, SECRET, now), true);
  assert.equal(verifySignature(body, header, SECRET, now + 299), true);
});

test('tampered, wrongly keyed, malformed, v0-only and stale signatures fail', () => {
  const now = 1_790_000_000;
  const header = signPayload(body, SECRET, now);
  assert.equal(verifySignature(body.replace('evt_1', 'evt_2'), header, SECRET, now), false);
  assert.equal(verifySignature(`${body} `, header, SECRET, now), false, 'raw body must be byte-exact');
  assert.equal(verifySignature(body, header, 'whsec_other', now), false);
  assert.equal(verifySignature(body, header.replace(/t=\d+/, `t=${now + 1}`), SECRET, now), false);
  const v0 = createHmac('sha256', SECRET).update(`${now}.${body}`).digest('hex');
  assert.equal(verifySignature(body, `t=${now},v0=${v0}`, SECRET, now), false);
  for (const bad of [null, '', 'garbage', `v1=${v0}`, `t=abc,v1=${v0}`, `t=${now},v1=short`]) {
    assert.equal(verifySignature(body, bad, SECRET, now), false, String(bad));
  }
  assert.equal(verifySignature(body, header, SECRET, now + 301), false, 'stale');
  assert.equal(verifySignature(body, header, SECRET, now - 301), false, 'from the future');
});

/* ── Stripe webhook → plan ─────────────────────────────────────────── */

const cfg = { secretKey: 'sk_test_x', webhookSecret: SECRET, prices: { pilot: 'price_pilot', team: 'price_team' } };
const P0 = 1_790_000_000, P1 = P0 + 30 * 86_400;
const sub = (over = {}) => ({
  id: 'sub_1', status: 'active', customer: 'cus_1', metadata: { workspace_id: 'ws-1' },
  items: { data: [{ id: 'si_1', price: { id: 'price_pilot' }, current_period_start: P0, current_period_end: P1 }] }, ...over,
});

/** A fake Stripe: GET /v1/subscriptions/:id answers from `subs`; every call is recorded. */
function mockStripe(subs) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const m = /\/v1\/subscriptions\/([^?]+)$/.exec(String(url));
    if (m && subs[m[1]]) return new Response(JSON.stringify(subs[m[1]]), { status: 200 });
    if (/billing_portal\/sessions|checkout\/sessions/.test(String(url))) return new Response(JSON.stringify({ url: 'https://stripe.test/session' }), { status: 200 });
    return new Response(JSON.stringify({ error: { message: 'No such subscription', code: 'resource_missing' } }), { status: 404 });
  };
  return calls;
}

function deps() {
  const kv = memoryStore();
  const plans = {};
  return { kv, cfg, plans, savePlan: async (id, plan) => { if (id !== 'ws-1') return false; plans[id] = plan; return true; } };
}

const event = (id, type, object, created = P0) => ({ id, type, created, data: { object } });

test('checkout.session.completed → active plan from the subscription, recorded and idempotent', async () => {
  const d = deps();
  const calls = mockStripe({ sub_1: sub() });
  const ev = event('evt_c', 'checkout.session.completed', { mode: 'subscription', client_reference_id: 'ws-1', customer: 'cus_1', subscription: 'sub_1' });
  assert.equal(await handleEvent(d, ev), 'applied');
  assert.deepEqual(d.plans['ws-1'], { tier: 'pilot', status: 'active', periodStart: P0 * 1000, periodEnd: P1 * 1000 });
  assert.equal(calls[0].init.headers['Stripe-Version'], STRIPE_API_VERSION);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk_test_x');
  const record = await d.kv.get(billingKey('ws-1'));
  assert.deepEqual([record.customerId, record.subscriptionId, record.itemId, record.priceId], ['cus_1', 'sub_1', 'si_1', 'price_pilot']);
  assert.equal(await d.kv.get('stripe-customer:cus_1'), 'ws-1');
  // Stripe retries the same event: nothing happens twice.
  d.plans['ws-1'] = 'untouched';
  assert.equal(await handleEvent(d, ev), 'duplicate');
  assert.equal(d.plans['ws-1'], 'untouched');
});

test('subscription updated (upgrade, renewal), payment failed, deleted', async () => {
  const d = deps();
  // Upgrade to Team: the event payload is ignored in favour of the fresh subscription.
  mockStripe({ sub_1: sub({ items: { data: [{ id: 'si_1', price: { id: 'price_team' }, current_period_start: P0, current_period_end: P1 }] } }) });
  assert.equal(await handleEvent(d, event('evt_u', 'customer.subscription.updated', { id: 'sub_1', status: 'stale-payload' })), 'applied');
  assert.equal(d.plans['ws-1'].tier, 'team');

  // invoice.payment_failed names its subscription under parent.subscription_details.
  mockStripe({ sub_1: sub({ status: 'past_due' }) });
  const invoice = { id: 'in_1', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1' } } };
  assert.equal(await handleEvent(d, event('evt_f', 'invoice.payment_failed', invoice)), 'applied');
  assert.equal(d.plans['ws-1'].status, 'past_due');
  assert.equal(await handleEvent(d, event('evt_f2', 'invoice.payment_failed', { id: 'in_2', parent: null })), 'ignored');

  // Retries exhausted (unpaid) and deletion both stop the plan.
  mockStripe({ sub_1: sub({ status: 'unpaid' }) });
  await handleEvent(d, event('evt_x', 'customer.subscription.updated', { id: 'sub_1' }));
  assert.equal(d.plans['ws-1'].status, 'canceled');
  mockStripe({ sub_1: sub({ status: 'canceled' }) });
  assert.equal(await handleEvent(d, event('evt_d', 'customer.subscription.deleted', { id: 'sub_1' })), 'applied');
  assert.equal(d.plans['ws-1'].status, 'canceled');
});

test('workspace found through the customer index when metadata is missing; unknown ones are ignored', async () => {
  const d = deps();
  await d.kv.set('stripe-customer:cus_1', 'ws-1');
  mockStripe({ sub_1: sub({ metadata: {} }), sub_9: sub({ id: 'sub_9', customer: 'cus_9', metadata: {} }) });
  assert.equal(await handleEvent(d, event('e1', 'customer.subscription.updated', { id: 'sub_1' })), 'applied');
  assert.equal(await handleEvent(d, event('e2', 'customer.subscription.updated', { id: 'sub_9' })), 'ignored');
  assert.equal(await handleEvent(d, event('e3', 'charge.refunded', {})), 'ignored');
});

test('an old subscription ending does not cancel its replacement; incomplete and foreign prices change nothing', async () => {
  const d = deps();
  mockStripe({});
  await applySubscription(d, 'ws-1', sub({ id: 'sub_new' }));
  assert.equal(await applySubscription(d, 'ws-1', sub({ id: 'sub_old', status: 'canceled' })), 'ignored');
  assert.equal(d.plans['ws-1'].status, 'active');
  assert.equal(planFromSubscription(cfg, sub({ status: 'incomplete' })), null);
  assert.equal(planFromSubscription(cfg, sub({ items: { data: [{ id: 'si', price: { id: 'price_other' }, current_period_start: 1, current_period_end: 2 }] } })), null);
  assert.equal(planFromSubscription(cfg, sub({ status: 'trialing' })).status, 'active');
  assert.equal(planFromSubscription(cfg, sub({ status: 'paused' })).status, 'canceled');
});

test('a Stripe outage while handling an event throws (so Stripe retries) and is not marked as seen', async () => {
  const d = deps();
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 });
  await assert.rejects(handleEvent(d, event('evt_o', 'customer.subscription.updated', { id: 'sub_1' })), /boom/);
  assert.equal(await d.kv.get('stripe-event:evt_o'), null);
});

/* ── checkout ──────────────────────────────────────────────────────── */

test('formEncode nests like Stripe expects', () => {
  assert.equal(
    decodeURIComponent(formEncode({ a: 1, line_items: [{ price: 'p', quantity: 1 }], m: { k: 'v w' }, skip: undefined })),
    'a=1&line_items[0][price]=p&line_items[0][quantity]=1&m[k]=v w',
  );
});

test('checkout: a new subscription goes to Checkout; an existing one to the portal confirm flow', async () => {
  const calls = mockStripe({});
  const base = { workspaceId: 'ws-1', email: 'owner@shop.com', origin: 'https://agentify.test', record: null, subscribed: false };
  assert.equal(await checkoutUrl(cfg, { ...base, tier: 'pilot' }), 'https://stripe.test/session');
  const form = new URLSearchParams(calls[0].init.body);
  assert.equal(calls[0].url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(form.get('mode'), 'subscription');
  assert.equal(form.get('line_items[0][price]'), 'price_pilot');
  assert.equal(form.get('client_reference_id'), 'ws-1');
  assert.equal(form.get('customer_email'), 'owner@shop.com');
  assert.equal(form.get('subscription_data[metadata][workspace_id]'), 'ws-1');
  assert.equal(form.get('success_url'), 'https://agentify.test/dashboard/settings?billing=success#billing');

  const record = { customerId: 'cus_1', subscriptionId: 'sub_1', itemId: 'si_1', priceId: 'price_pilot', updatedAt: 0 };
  await checkoutUrl(cfg, { ...base, tier: 'team', record, subscribed: true });
  const portal = new URLSearchParams(calls[1].init.body);
  assert.equal(calls[1].url, 'https://api.stripe.com/v1/billing_portal/sessions');
  assert.equal(portal.get('flow_data[type]'), 'subscription_update_confirm');
  assert.equal(portal.get('flow_data[subscription_update_confirm][items][0][id]'), 'si_1');
  assert.equal(portal.get('flow_data[subscription_update_confirm][items][0][price]'), 'price_team');
  await assert.rejects(checkoutUrl(cfg, { ...base, tier: 'pilot', record, subscribed: true }), { code: 'already_on_plan' });
  await assert.rejects(checkoutUrl(cfg, { ...base, tier: 'studio' }), { code: 'not_purchasable' });

  // Buying again after a cancellation reuses the customer.
  await checkoutUrl(cfg, { ...base, tier: 'pilot', record, subscribed: false });
  const again = new URLSearchParams(calls.at(-1).init.body);
  assert.equal(again.get('customer'), 'cus_1');
  assert.equal(again.get('customer_email'), null);
});

test('a step that used no tokens is not counted', async () => {
  const kv = memoryStore();
  const ws = workspace();
  await addUsage(kv, ws, { input: 0, output: 0 }, { now: T0 + 1 });
  assert.deepEqual(await readUsage(kv, ws, { now: T0 + 2 }), { tokens: 0, steps: 0, tokenLimit: PLANS.pilot.tokenLimit });
});
