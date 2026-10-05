/**
 * Plans, usage and limits, wired to the real store, environment and
 * HttpError. The logic lives in usage.ts and stripe.ts (testable on their
 * own); this file is what the step runner and the API routes call.
 *
 * Stripe is on when STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and both price
 * ids (STRIPE_PRICE_PILOT, STRIPE_PRICE_TEAM) are set. Without it the
 * workspace keeps whatever plan it has (a trial, or one set by hand).
 */
import type { PlanState, Tier, Usage, User, Workspace } from '../../agency/types';
import { OFFERED, PLANS, displayPrice } from '../../agency/plans';
import type { Billing, PlanOffer } from '../../app/api';
import { HttpError } from '../auth';
import { getWorkspace, saveWorkspace } from '../repo';
import { getStore } from '../storage';
import { currentPlan, addUsage, memberDenial, readUsage, runDenial, storeDenial, type Denial, type UsageOptions } from './usage';
import {
  StripeError, billingKey, checkoutUrl, handleEvent, portalUrl, verifySignature,
  type BillingRecord, type StripeConfig, type StripeEvent,
} from './stripe';

const env = (name: string): string | undefined => process.env[name] ?? (import.meta.env?.[name] as string | undefined);

function stripeConfig(): StripeConfig | null {
  const secretKey = env('STRIPE_SECRET_KEY'), webhookSecret = env('STRIPE_WEBHOOK_SECRET');
  const pilot = env('STRIPE_PRICE_PILOT'), team = env('STRIPE_PRICE_TEAM');
  if (!secretKey || !webhookSecret || !pilot || !team) return null;
  return { secretKey, webhookSecret, prices: { pilot, team } };
}

/** Whether Stripe is configured on this server. */
export function billingConfigured(): boolean {
  return stripeConfig() !== null;
}

function usageOptions(): UsageOptions {
  const limit = Number(env('AGENTIFY_TOKEN_LIMIT'));
  // The scripted model reports no tokens; this lets the ceiling be reached locally.
  const minStep = env('AGENTIFY_FAKE_LLM') === '1' ? Number(env('AGENTIFY_MIN_STEP_TOKENS')) : 0;
  return { tokenLimit: limit > 0 ? limit : undefined, minStepTokens: minStep > 0 ? minStep : undefined };
}

const deny = (d: Denial | null) => { if (d) throw new HttpError(402, d.code, d.message); };

const toHttp = (err: unknown): never => {
  if (err instanceof StripeError) throw new HttpError(err.status, err.code, err.message);
  throw err;
};

/** The plan with a lapsed monthly period rolled forward, saved back when it moved. */
async function freshPlan(workspace: Workspace): Promise<PlanState> {
  const plan = currentPlan(workspace.plan);
  if (plan.periodStart !== workspace.plan.periodStart) {
    const fresh = await getWorkspace(workspace.id);
    if (fresh && fresh.plan.periodStart === workspace.plan.periodStart) {
      fresh.plan = plan;
      await saveWorkspace(fresh);
    }
    workspace.plan = plan;
  }
  return plan;
}

/** What the workspace has used in its current period, and its plan's ceiling. */
export async function getUsage(workspace: Workspace): Promise<Usage> {
  return readUsage(getStore(), workspace, usageOptions());
}

/**
 * Throw an HttpError (402, code "plan_limit" or "plan_inactive") with a
 * message for the client when the workspace may not run another agent step.
 */
export async function assertCanRun(workspace: Workspace): Promise<void> {
  await freshPlan(workspace);
  deny(runDenial(workspace, await getUsage(workspace)));
}

/** Throw an HttpError (402, code "plan_limit") when the workspace's plan does not allow another store. */
export async function assertCanAddStore(workspace: Workspace): Promise<void> {
  deny(storeDenial(workspace));
}

/** Throw an HttpError (402, "plan_limit") when `seats` (members + pending invitations) already fill the plan. */
export function assertSeatFree(workspace: Workspace, seats: number): void {
  deny(memberDenial(workspace, seats));
}

/** Count one finished agent step against the workspace's current period. */
export async function recordUsage(workspace: Workspace, tokens: { input: number; output: number }): Promise<void> {
  await addUsage(getStore(), workspace, tokens, usageOptions());
}

/* ── the billing screen ────────────────────────────────────────────── */

export function offers(): PlanOffer[] {
  const limit = usageOptions().tokenLimit;
  return OFFERED.map((tier) => {
    const p = PLANS[tier];
    return {
      tier, name: p.name, ...displayPrice(tier), tokenLimit: limit ?? p.tokenLimit, storeLimit: p.storeLimit,
      memberLimit: p.memberLimit, purchasable: p.purchasable,
    };
  });
}

export async function billingSummary(workspace: Workspace): Promise<Billing> {
  const plan = await freshPlan(workspace);
  return { plan, usage: await getUsage(workspace), offers: offers() };
}

function requireStripe(): StripeConfig {
  const cfg = stripeConfig();
  if (!cfg) throw new HttpError(503, 'billing_not_configured', 'Billing is not connected on this server, so plans cannot be bought here. Contact us to change your plan.');
  return cfg;
}

export async function startCheckout(user: User, workspace: Workspace, tier: unknown, origin: string): Promise<string> {
  const cfg = requireStripe();
  if (typeof tier !== 'string' || !(tier in PLANS)) throw new HttpError(400, 'bad_request', 'Choose a plan.');
  if (!PLANS[tier as Tier].purchasable) throw new HttpError(400, 'not_purchasable', 'That plan is not sold online. Contact us for Studio.');
  const record = await getStore().get<BillingRecord>(billingKey(workspace.id));
  const subscribed = workspace.plan.tier !== 'trial' && (workspace.plan.status === 'active' || workspace.plan.status === 'past_due');
  return checkoutUrl(cfg, { workspaceId: workspace.id, email: user.email, tier: tier as Tier, origin, record, subscribed }).catch(toHttp);
}

export async function openPortal(workspace: Workspace, origin: string): Promise<string> {
  const cfg = requireStripe();
  const record = await getStore().get<BillingRecord>(billingKey(workspace.id));
  return portalUrl(cfg, record, origin).catch(toHttp);
}

/** Verify and apply one webhook delivery. `raw` must be the body exactly as received. */
export async function receiveWebhook(raw: string, signature: string | null): Promise<string> {
  const cfg = stripeConfig();
  if (!cfg) throw new HttpError(503, 'billing_not_configured', 'Billing is not configured.');
  if (!verifySignature(raw, signature, cfg.webhookSecret)) throw new HttpError(400, 'bad_signature', 'Invalid Stripe signature.');
  let event: StripeEvent;
  try {
    event = JSON.parse(raw) as StripeEvent;
  } catch {
    throw new HttpError(400, 'bad_request', 'Invalid JSON.');
  }
  return handleEvent({
    kv: getStore(), cfg,
    savePlan: async (workspaceId, plan) => {
      const ws = await getWorkspace(workspaceId);
      if (!ws) return false;
      ws.plan = plan;
      await saveWorkspace(ws);
      return true;
    },
  }, event).catch(toHttp);
}
