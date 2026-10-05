/**
 * Stripe over its REST API, without the SDK: form-encoded requests, webhook
 * signature verification, and the mapping from a Subscription to the
 * workspace's PlanState. No imports from the rest of the server (the store
 * and workspace access are passed in), so it runs under plain Node in tests.
 *
 * Written against API version 2026-09-30.endive, pinned on every request.
 * The webhook endpoint must be created with the same version: the payload
 * shape follows the endpoint's version, not the request header. In this
 * version a subscription's period lives on its items, and an invoice names
 * its subscription under parent.subscription_details.
 *
 * Webhooks are treated as "something changed" signals: every event that
 * concerns a subscription re-reads it from Stripe and applies its current
 * state. Delivery order and retries then do not matter.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PlanState, Tier } from '../../agency/types';
import type { Store as KV } from '../storage';

export const STRIPE_API_VERSION = '2026-09-30.endive';
/** Seconds a signed webhook stays acceptable (the official libraries' default). */
export const SIGNATURE_TOLERANCE = 300;

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  prices: Partial<Record<Tier, string>>;
}

export class StripeError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/* ── requests ──────────────────────────────────────────────────────── */

type Param = string | number | boolean | null | undefined | Param[] | { [key: string]: Param };

/** Stripe's form encoding: nested objects and arrays as a[b][0][c]=v. */
export function formEncode(params: Record<string, Param>): string {
  const out: string[] = [];
  const walk = (key: string, value: Param) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v, i) => walk(`${key}[${i}]`, v));
    else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(`${key}[${k}]`, v);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out.join('&');
}

export async function stripeRequest<T>(cfg: Pick<StripeConfig, 'secretKey'>, method: 'GET' | 'POST', path: string, params?: Record<string, Param>): Promise<T> {
  const body = params ? formEncode(params) : '';
  let res: Response;
  try {
    res = await fetch(`https://api.stripe.com${path}${method === 'GET' && body ? `?${body}` : ''}`, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.secretKey}`,
        'Stripe-Version': STRIPE_API_VERSION,
        ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: method === 'POST' ? body : undefined,
    });
  } catch {
    throw new StripeError(502, 'stripe_unreachable', 'Could not reach Stripe. Try again in a moment.');
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: { message?: string; code?: string } }) | null;
  if (!res.ok || !data) {
    const message = data?.error?.message ?? `Stripe returned ${res.status}.`;
    throw new StripeError(res.status >= 500 ? 502 : res.status, data?.error?.code ?? 'stripe_error', message);
  }
  return data;
}

/* ── webhook signatures ────────────────────────────────────────────── */

/**
 * Check a `Stripe-Signature` header ("t=…,v1=…[,v1=…][,v0=…]") against the
 * raw request body: HMAC-SHA256 of "t.body" with the endpoint secret, hex.
 * Any v1 may match (a rolled secret sends two); other schemes are ignored.
 */
export function verifySignature(rawBody: string, header: string | null, secret: string, nowSec = Math.floor(Date.now() / 1000), tolerance = SIGNATURE_TOLERANCE): boolean {
  if (!header || !secret) return false;
  let t = '';
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim(), value = part.slice(i + 1).trim();
    if (key === 't') t = value;
    else if (key === 'v1') sigs.push(value);
  }
  if (!/^\d+$/.test(t) || !sigs.length) return false;
  if (Math.abs(nowSec - Number(t)) > tolerance) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex'));
  return sigs.some((s) => {
    const given = Buffer.from(s);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** Sign a payload the way Stripe does; for tests and local replays. */
export function signPayload(rawBody: string, secret: string, tSec = Math.floor(Date.now() / 1000)): string {
  return `t=${tSec},v1=${createHmac('sha256', secret).update(`${tSec}.${rawBody}`, 'utf8').digest('hex')}`;
}

/* ── subscriptions → plans ─────────────────────────────────────────── */

export interface StripeSubscription {
  id: string;
  status: 'incomplete' | 'incomplete_expired' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused';
  customer: string;
  metadata?: Record<string, string>;
  items: { data: { id: string; price: { id: string }; current_period_start: number; current_period_end: number }[] };
}

export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}

/** What we remember about a workspace's Stripe side. */
export interface BillingRecord {
  customerId: string;
  subscriptionId: string | null;
  /** The subscription item, needed to switch its price. */
  itemId: string | null;
  priceId: string | null;
  updatedAt: number;
}

export const billingKey = (workspaceId: string) => `billing:${workspaceId}`;
export const customerKey = (customerId: string) => `stripe-customer:${customerId}`;
const eventKey = (eventId: string) => `stripe-event:${eventId}`;

export function tierForPrice(cfg: StripeConfig, priceId: string): Tier | null {
  for (const [tier, id] of Object.entries(cfg.prices)) if (id && id === priceId) return tier as Tier;
  return null;
}

/**
 * The plan a subscription stands for, or null when it says nothing yet
 * (first payment still pending) or its price is not one of ours.
 */
export function planFromSubscription(cfg: StripeConfig, sub: StripeSubscription): PlanState | null {
  const item = sub.items?.data?.[0];
  if (!item || sub.status === 'incomplete') return null;
  const tier = tierForPrice(cfg, item.price.id);
  if (!tier) return null;
  const status: PlanState['status'] =
    sub.status === 'active' || sub.status === 'trialing' ? 'active'
      : sub.status === 'past_due' ? 'past_due'
        : 'canceled'; // canceled, unpaid (retries exhausted), paused, incomplete_expired
  return { tier, status, periodStart: item.current_period_start * 1000, periodEnd: item.current_period_end * 1000 };
}

export interface WebhookDeps {
  kv: KV;
  cfg: StripeConfig;
  /** Replace the workspace's plan (re-reading it first); false when the workspace does not exist. */
  savePlan: (workspaceId: string, plan: PlanState) => Promise<boolean>;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
/** An expandable field: an id, or the object with one. */
const idOf = (v: unknown): string | null => str(v) ?? (v && typeof v === 'object' ? str((v as { id?: unknown }).id) : null);

export type WebhookOutcome = 'applied' | 'ignored' | 'duplicate';

/** Handle one verified event. Throws on transient failures so Stripe retries. */
export async function handleEvent(deps: WebhookDeps, event: StripeEvent): Promise<WebhookOutcome> {
  const { kv, cfg } = deps;
  if (await kv.get(eventKey(event.id))) return 'duplicate';
  const obj = event.data?.object ?? {};
  let workspaceId: string | null = null;
  let subscriptionId: string | null = null;

  switch (event.type) {
    case 'checkout.session.completed': {
      if (obj.mode !== 'subscription') return 'ignored';
      workspaceId = str(obj.client_reference_id);
      subscriptionId = idOf(obj.subscription);
      const customerId = idOf(obj.customer);
      if (!workspaceId || !subscriptionId || !customerId) return 'ignored';
      await kv.set(customerKey(customerId), workspaceId);
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed':
      subscriptionId = str(obj.id);
      break;
    case 'invoice.payment_failed':
    case 'invoice.paid': {
      const parent = obj.parent as { type?: string; subscription_details?: { subscription?: unknown } } | null | undefined;
      subscriptionId = parent?.type === 'subscription_details' ? idOf(parent.subscription_details?.subscription) : null;
      break;
    }
    default:
      return 'ignored';
  }
  if (!subscriptionId) return 'ignored';

  const sub = await stripeRequest<StripeSubscription>(cfg, 'GET', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
  workspaceId ??= str(sub.metadata?.workspace_id) ?? (await kv.get<string>(customerKey(sub.customer)));
  if (!workspaceId) {
    console.warn(`Stripe ${event.type} ${event.id}: subscription ${sub.id} belongs to no known workspace.`);
    return 'ignored';
  }
  const outcome = await applySubscription(deps, workspaceId, sub);
  await kv.set(eventKey(event.id), event.created);
  return outcome;
}

/** Record a subscription's current state on the workspace. Idempotent. */
export async function applySubscription(deps: WebhookDeps, workspaceId: string, sub: StripeSubscription): Promise<WebhookOutcome> {
  const { kv, cfg } = deps;
  const record = await kv.get<BillingRecord>(billingKey(workspaceId));
  const item = sub.items?.data?.[0];
  const terminal = ['canceled', 'incomplete_expired'].includes(sub.status);
  // An old subscription ending must not override the one that replaced it.
  if (record?.subscriptionId && record.subscriptionId !== sub.id && terminal) return 'ignored';
  const plan = planFromSubscription(cfg, sub);
  if (!plan) {
    if (item && !tierForPrice(cfg, item.price.id)) console.warn(`Stripe subscription ${sub.id} has price ${item.price.id}, which is not STRIPE_PRICE_PILOT or STRIPE_PRICE_TEAM.`);
    return 'ignored';
  }
  if (!(await deps.savePlan(workspaceId, plan))) return 'ignored';
  await kv.set<BillingRecord>(billingKey(workspaceId), {
    customerId: sub.customer, subscriptionId: sub.id, itemId: item?.id ?? null, priceId: item?.price.id ?? null, updatedAt: Date.now(),
  });
  await kv.set(customerKey(sub.customer), workspaceId);
  return 'applied';
}

/* ── checkout and portal ───────────────────────────────────────────── */

export interface CheckoutInput {
  workspaceId: string;
  email: string;
  tier: Tier;
  origin: string;
  record: BillingRecord | null;
  /** The workspace's subscription is live (active or past due): change it instead of buying a second one. */
  subscribed: boolean;
}

const settingsUrl = (origin: string, flag: string) => `${origin}/dashboard/settings?billing=${flag}#billing`;

/** Where to send the browser to buy `tier`, or to confirm a switch to it on the existing subscription. */
export async function checkoutUrl(cfg: StripeConfig, input: CheckoutInput): Promise<string> {
  const price = cfg.prices[input.tier];
  if (!price) throw new StripeError(400, 'not_purchasable', 'That plan cannot be bought online. Contact us for Studio.');
  const { record } = input;

  if (input.subscribed && record?.subscriptionId && record.itemId) {
    if (record.priceId === price) throw new StripeError(409, 'already_on_plan', 'The workspace is already on that plan.');
    // Stripe's portal shows the change, the proration and the confirmation; requires the portal configuration to allow price updates.
    const session = await stripeRequest<{ url: string }>(cfg, 'POST', '/v1/billing_portal/sessions', {
      customer: record.customerId,
      return_url: settingsUrl(input.origin, 'portal'),
      flow_data: {
        type: 'subscription_update_confirm',
        subscription_update_confirm: { subscription: record.subscriptionId, items: [{ id: record.itemId, price, quantity: 1 }] },
        after_completion: { type: 'redirect', redirect: { return_url: settingsUrl(input.origin, 'updated') } },
      },
    });
    return session.url;
  }

  const session = await stripeRequest<{ url: string }>(cfg, 'POST', '/v1/checkout/sessions', {
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    client_reference_id: input.workspaceId,
    ...(record?.customerId ? { customer: record.customerId } : { customer_email: input.email }),
    subscription_data: { metadata: { workspace_id: input.workspaceId, tier: input.tier } },
    allow_promotion_codes: true,
    success_url: settingsUrl(input.origin, 'success'),
    cancel_url: settingsUrl(input.origin, 'canceled'),
  });
  return session.url;
}

export async function portalUrl(cfg: StripeConfig, record: BillingRecord | null, origin: string): Promise<string> {
  if (!record?.customerId) throw new StripeError(409, 'no_billing_account', 'There is no billing account for this workspace yet. Choose a plan first.');
  const session = await stripeRequest<{ url: string }>(cfg, 'POST', '/v1/billing_portal/sessions', {
    customer: record.customerId, return_url: settingsUrl(origin, 'portal'),
  });
  return session.url;
}
