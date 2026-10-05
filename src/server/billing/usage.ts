/**
 * Usage accounting and plan limits, over an injected key-value store. No
 * imports from the rest of the server, so it runs under plain Node in tests
 * (see billing.test.mjs); index.ts wires it to the real store and HttpError.
 *
 * The counter has no read-modify-write: every finished step writes its own
 * small record, and a read sums the period's records. Steps on different
 * requests finishing at once therefore never lose an increment. When a
 * period gathers many records, one recordUsage folds them into a single
 * compacted record that names every key it absorbed; readers skip absorbed
 * keys, so a compaction that dies half-way never double counts.
 */
import { randomUUID } from 'node:crypto';
import type { PlanState, Usage, Workspace } from '../../agency/types';
import type { Store as KV } from '../storage';
import { PLANS, formatTokens } from '../../agency/plans.ts';

const DAY = 86_400_000;
/** Fold a period's records once there are this many. */
const COMPACT_AT = 40;
const COMPACT_LOCK_MS = 30_000;

interface StepRecord { tokens: number; steps: number; at: number }
interface CompactRecord { tokens: number; steps: number; at: number; folded: string[] }

const periodPrefix = (workspaceId: string, periodStart: number) => `usage:${workspaceId}:${periodStart}:`;

/** Overrides for operators and local testing. */
export interface UsageOptions {
  /** Replace every plan's token ceiling (AGENTIFY_TOKEN_LIMIT). */
  tokenLimit?: number;
  /** Count each step as at least this many tokens (AGENTIFY_MIN_STEP_TOKENS, with the scripted model only). */
  minStepTokens?: number;
  now?: number;
}

/* ── periods ───────────────────────────────────────────────────────── */

/** `start` plus one calendar month (UTC), keeping the anchor day where the month has it (Jan 31 → Feb 28 → Mar 31). */
export function addMonth(start: number, anchorDay = new Date(start).getUTCDate()): number {
  const d = new Date(start);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(anchorDay, last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

/**
 * The plan with its period brought up to date. Paid tiers roll over monthly
 * when the period lapses (a Stripe renewal sets the same start a moment later;
 * the next period always begins where the last ended). The trial never rolls
 * over, and neither does a cancelled plan.
 */
export function currentPlan(plan: PlanState, now = Date.now()): PlanState {
  if (plan.tier === 'trial' || plan.status === 'canceled' || now < plan.periodEnd) return plan;
  const anchorDay = new Date(plan.periodStart).getUTCDate();
  let { periodStart, periodEnd } = plan;
  // Guard against a corrupt period (end <= start) looping forever.
  if (periodEnd <= periodStart) periodEnd = addMonth(periodStart, anchorDay);
  while (now >= periodEnd) {
    periodStart = periodEnd;
    periodEnd = addMonth(periodStart, anchorDay);
  }
  return { ...plan, periodStart, periodEnd };
}

/* ── the counter ───────────────────────────────────────────────────── */

async function readPeriod(kv: KV, prefix: string): Promise<{ keys: string[]; tokens: number; steps: number }> {
  const keys = await kv.keys(prefix);
  const values = await kv.getMany<StepRecord | CompactRecord>(keys);
  const folded = new Set<string>();
  for (const v of values) if (v && 'folded' in v) for (const k of v.folded) folded.add(k);
  let tokens = 0, steps = 0;
  const present: string[] = [];
  keys.forEach((key, i) => {
    const v = values[i];
    if (!v) return; // deleted between the scan and the read
    present.push(key);
    if (folded.has(key)) return;
    tokens += v.tokens;
    steps += v.steps;
  });
  return { keys: present, tokens, steps };
}

export function tokenLimitFor(plan: PlanState, opts: UsageOptions = {}): number {
  return opts.tokenLimit && opts.tokenLimit > 0 ? opts.tokenLimit : PLANS[plan.tier].tokenLimit;
}

/** What the workspace has used in its current period. */
export async function readUsage(kv: KV, workspace: Workspace, opts: UsageOptions = {}): Promise<Usage> {
  const plan = currentPlan(workspace.plan, opts.now);
  const { tokens, steps } = await readPeriod(kv, periodPrefix(workspace.id, plan.periodStart));
  return { tokens, steps, tokenLimit: tokenLimitFor(plan, opts) };
}

/** Add one finished step to the current period. */
export async function addUsage(kv: KV, workspace: Workspace, used: { input: number; output: number }, opts: UsageOptions = {}): Promise<void> {
  const now = opts.now ?? Date.now();
  const plan = currentPlan(workspace.plan, now);
  const prefix = periodPrefix(workspace.id, plan.periodStart);
  const counted = Math.max(0, Math.round((used.input || 0) + (used.output || 0)));
  // A step that never reached the model (refused by the plan, failed early) is not a step run.
  if (counted === 0 && !opts.minStepTokens) return;
  const tokens = Math.max(counted, opts.minStepTokens ?? 0);
  await kv.set<StepRecord>(`${prefix}s:${now}:${randomUUID()}`, { tokens, steps: 1, at: now });
  await compact(kv, workspace.id, prefix, now).catch(() => {}); // best effort: the counter is right either way
}

/** Fold the period's records into one, if there are many. One compactor at a time per workspace. */
export async function compact(kv: KV, workspaceId: string, prefix: string, now = Date.now(), threshold = COMPACT_AT): Promise<boolean> {
  const keys = await kv.keys(prefix);
  if (keys.length < threshold) return false;
  const lock = `usage-lock:${workspaceId}`;
  if (!(await kv.setIfAbsent(lock, now + COMPACT_LOCK_MS))) {
    const until = await kv.get<number>(lock);
    if (until && until > now) return false;
    await kv.set(lock, now + COMPACT_LOCK_MS); // a compactor died holding it
  }
  try {
    const period = await readPeriod(kv, prefix);
    // Every key read is absorbed: counted ones by value, already-folded ones by their compactor's total.
    await kv.set<CompactRecord>(`${prefix}c:${now}:${randomUUID()}`, { tokens: period.tokens, steps: period.steps, at: now, folded: period.keys });
    for (const key of period.keys) await kv.delete(key);
    return true;
  } finally {
    await kv.delete(lock);
  }
}

/* ── limits ────────────────────────────────────────────────────────── */

export interface Denial {
  code: 'plan_limit' | 'plan_inactive';
  message: string;
}

const day = (at: number) => new Date(at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
const WHERE = 'Settings → Plan & usage';

/** Why the plan itself does not allow work right now, or null. */
export function planDenial(plan: PlanState, now = Date.now()): Denial | null {
  if (plan.tier === 'trial' && now >= plan.periodEnd) {
    return { code: 'plan_inactive', message: `Your free trial ended on ${day(plan.periodEnd)}. Choose a plan in ${WHERE}, then press Retry and the team picks up where it stopped — your requests are saved.` };
  }
  if (plan.status === 'canceled') {
    return { code: 'plan_inactive', message: `Your ${PLANS[plan.tier].name} plan is no longer active. Choose a plan in ${WHERE} to put the team back to work — nothing has been deleted.` };
  }
  return null;
}

/** Why the workspace may not run another agent step, or null. */
export function runDenial(workspace: Workspace, usage: Usage, now = Date.now()): Denial | null {
  const inactive = planDenial(workspace.plan, now);
  if (inactive) return inactive;
  if (usage.tokens >= usage.tokenLimit) {
    const plan = currentPlan(workspace.plan, now);
    const renews = plan.tier === 'trial' ? 'The trial allowance does not renew' : `It renews on ${day(plan.periodEnd)}`;
    return {
      code: 'plan_limit',
      message: `This workspace has used its ${formatTokens(usage.tokenLimit)} tokens for this period. ${renews}; to continue now, upgrade in ${WHERE}, then press Retry on the request and the team carries on from where it stopped.`,
    };
  }
  return null;
}

export function storeDenial(workspace: Workspace): Denial | null {
  const plan = PLANS[workspace.plan.tier];
  if (workspace.stores.length < plan.storeLimit) return null;
  const n = plan.storeLimit;
  return { code: 'plan_limit', message: `The ${plan.name} plan includes ${n} store${n === 1 ? '' : 's'}, and this workspace has ${workspace.stores.length}. Remove one, or upgrade in ${WHERE}.` };
}

/** `seats` counts members plus pending invitations. */
export function memberDenial(workspace: Workspace, seats: number): Denial | null {
  const plan = PLANS[workspace.plan.tier];
  if (seats < plan.memberLimit) return null;
  return { code: 'plan_limit', message: `The ${plan.name} plan has ${plan.memberLimit} seats and all of them are taken (pending invitations hold a seat). Revoke an invitation, remove a member, or upgrade in ${WHERE}.` };
}

export { DAY };
