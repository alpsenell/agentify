/**
 * The plans: what each tier allows. Shared by the server (limits, billing)
 * and the app (the plan cards). Display prices come from the public pricing
 * page's data so the two can never disagree.
 *
 * The token ceiling is a cost guard, not the product. The agents run on
 * claude-opus-5-5 at $4 / $20 per million input / output tokens. A full
 * request (six agents, Volt and Forge looping over tools, the dossier re-sent
 * on every turn) is roughly 300–500k tokens, about 85% of it input, so ~$2.50.
 * At a pessimistic 80/20 mix a million tokens costs at most $7.20; each
 * ceiling below keeps the worst-case model bill near 15% of the plan's price.
 *
 * A "store" is one Store record (one Shopify store or one environment of it),
 * so one storefront with a staging copy is two.
 */
import type { Tier } from './types';
import { TIERS as PRICING } from '../data/pricing.ts';

export interface Plan {
  tier: Tier;
  name: string;
  /** Model tokens (input + output) per period. */
  tokenLimit: number;
  storeLimit: number;
  /** People in the workspace, owner included; pending invitations hold a seat. */
  memberLimit: number;
  /** Sold through Stripe checkout. Studio is sold by conversation; the trial is not sold. */
  purchasable: boolean;
}

export const PLANS: Record<Tier, Plan> = {
  // 14 days, ~6 full requests; worst case ~$18 of model time.
  trial: { tier: 'trial', name: 'Trial', tokenLimit: 2_500_000, storeLimit: 1, memberLimit: 2, purchasable: false },
  // $2,250/mo: ~100 requests; worst case $288 (13%). One store plus a staging copy.
  pilot: { tier: 'pilot', name: 'Pilot', tokenLimit: 40_000_000, storeLimit: 2, memberLimit: 3, purchasable: true },
  // $4,900/mo: ~250 requests; worst case $720 (15%). One store in all three environments.
  team: { tier: 'team', name: 'Team', tokenLimit: 100_000_000, storeLimit: 3, memberLimit: 10, purchasable: true },
  // Custom contract: up to six stores × three environments, priced per scope.
  studio: { tier: 'studio', name: 'Studio', tokenLimit: 300_000_000, storeLimit: 18, memberLimit: 25, purchasable: false },
};

/** The plans shown as cards, in order. */
export const OFFERED: readonly Tier[] = ['pilot', 'team', 'studio'];

/** Display price and unit from the pricing page ("$2,250", "per month · one store"); "" for custom pricing. */
export function displayPrice(tier: Tier): { price: string; unit: string } {
  const row = PRICING.find((t) => t.kicker.toLowerCase() === tier);
  if (!row) return { price: '', unit: tier === 'trial' ? `free for the trial period` : '' };
  return { price: /^\$/.test(row.price) ? row.price : '', unit: row.unit };
}

/** "40M", "2.5M", "850k": token counts for people. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}
