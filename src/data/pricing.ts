/**
 * Data behind the Pricing page — tiers, estimator inputs, the comparison
 * matrix and the FAQ. Figures come straight from the design source
 * (Pricing.dc.html); the estimator formula lives here so the build-time
 * default and the client script cannot drift apart.
 */

export interface Tier {
  kicker: string;
  price: string;
  unit: string;
  cta: string;
  slots: string;
  featured?: boolean;
  pitch: string;
  features: string[];
}

export const TIERS: Tier[] = [
  {
    kicker: 'Pilot',
    price: '$2,250',
    unit: 'per month · one store',
    cta: 'Open a pilot',
    slots: '4 slots',
    pitch:
      'Four roles on shift and a weekly gate. Enough to prove the cadence on one store before you commit anything.',
    features: [
      'Four agents of your choice',
      'Weekly human review',
      'Full pipeline log and diffs',
      'Own board from day one',
      'Two-week exit, no notice',
    ],
  },
  {
    kicker: 'Team',
    price: '$4,900',
    unit: 'per month · one store',
    cta: 'Talk to us',
    slots: '2 slots',
    featured: true,
    pitch:
      'The whole team, a daily gate, and an experiment queue that never stops. This is the configuration most stores settle on.',
    features: [
      'All ten roles on shift',
      'Daily review, same-day ship',
      'Experiment queue always running',
      'Plus and headless ready',
      'Shared Slack channel',
      'Named human operator',
    ],
  },
  {
    kicker: 'Studio',
    price: 'Custom',
    unit: 'multi-store · white label',
    cta: 'Request scope',
    slots: 'by intake',
    pitch:
      'For groups and agencies: several stores, your playbooks encoded as agents, your logo on the board.',
    features: [
      'Multiple stores or brands',
      'White-label for agencies',
      'Custom agents on your playbooks',
      'Dedicated planner and SLA',
      'Quarterly governance review',
    ],
  },
];

/** The ten roles, in board order. "You" is the human operator. */
export const ROLE_ORDER = [
  'Atlas', 'Muse', 'Volt', 'Sieve', 'Quill', 'Forge', 'Beacon', 'Ledger', 'Relay', 'You',
] as const;

export type Cadence = 'Weekly' | 'Daily' | 'Hourly';

export const CADENCES: Record<Cadence, number> = { Weekly: 0, Daily: 700, Hourly: 1450 };
export const CADENCE_KEYS = Object.keys(CADENCES) as Cadence[];

export interface Addon {
  key: string;
  label: string;
  price: number;
}

export const ADDONS: Addon[] = [
  { key: 'headless', label: 'Headless or custom storefront', price: 900 },
  { key: 'migration', label: 'Platform migration support', price: 1200 },
  { key: 'whitelabel', label: 'White-label for your clients', price: 600 },
  { key: 'sla', label: 'One-hour incident SLA', price: 450 },
];

export interface MatrixRow {
  label: string;
  a: string;
  b: string;
  c: string;
}

export const MATRIX: MatrixRow[] = [
  { label: 'Roles on shift', a: 'Four', b: 'All ten', c: 'All ten, plus custom' },
  { label: 'Human gate cadence', a: 'Weekly', b: 'Daily', c: 'Hourly available' },
  { label: 'Stores covered', a: 'One', b: 'One', c: 'Up to six' },
  { label: 'Experiment queue', a: 'On request', b: 'Always running', c: 'Always running' },
  { label: 'Pipeline log and diffs', a: 'Included', b: 'Included', c: 'Included' },
  { label: 'Auto-revert on regression', a: 'Included', b: 'Included', c: 'Included' },
  { label: 'Named human operator', a: '—', b: 'Included', c: 'Dedicated planner' },
  { label: 'White label', a: '—', b: '—', c: 'Included' },
  { label: 'Notice to cancel', a: 'Two weeks', b: 'One month', c: 'Per agreement' },
];

export interface Faq {
  q: string;
  a: string;
}

export const FAQS: Faq[] = [
  {
    q: 'What counts as one store?',
    a: 'One Shopify store and its theme, however many markets or currencies it serves. A second brand on a second store is a second seat, priced at 60% of the first.',
  },
  {
    q: 'What happens if we use fewer actions than budgeted?',
    a: 'Nothing rolls over. The budget is a ceiling that keeps the agents from inventing work, not a bank of hours you are paying to bank.',
  },
  {
    q: 'Is the human operator yours or ours?',
    a: 'Ours on Pilot and Team — a named person who holds the gate with you. On Studio you can appoint your own operators and we train them on the board.',
  },
  {
    q: 'Do we own what the agents produce?',
    a: 'Yes. Every branch, spec, test and log is yours, and it stays in your repository and your store. Cancelling does not take anything back.',
  },
  {
    q: 'Can we pause instead of cancel?',
    a: 'Yes, for up to two months. The board freezes, the queue is preserved, and billing drops to a $300 hold per store.',
  },
];

/* ── estimator ─────────────────────────────────────────────────────── */

export const ESTIMATOR = {
  base: 950,
  perRole: 325,
  /** Each extra store costs 60% of (base + roles). */
  extraStoreRate: 0.6,
  roles: { min: 2, max: 10, step: 1, default: 6 },
  stores: { min: 1, max: 6, step: 1, default: 1 },
  defaultCadence: 'Daily' as Cadence,
} as const;

export interface EstimatorState {
  roles: number;
  stores: number;
  cadence: Cadence;
  addons: string[];
}

export const DEFAULT_STATE: EstimatorState = {
  roles: ESTIMATOR.roles.default,
  stores: ESTIMATOR.stores.default,
  cadence: ESTIMATOR.defaultCadence,
  addons: [],
};

export const money = (n: number): string => '$' + n.toLocaleString('en-US');

export interface Line {
  label: string;
  value: string;
}

export interface Estimate {
  base: number;
  rolesCost: number;
  storesCost: number;
  cadenceCost: number;
  addonsCost: number;
  total: number;
  closest: string;
  lines: Line[];
  roleCount: string;
  storeCount: string;
}

/** The pricing formula, shared by the Astro build and the client script. */
export function estimate(state: EstimatorState): Estimate {
  const base = ESTIMATOR.base;
  const rolesCost = state.roles * ESTIMATOR.perRole;
  const storesCost = (state.stores - 1) * Math.round((base + rolesCost) * ESTIMATOR.extraStoreRate);
  const cadenceCost = CADENCES[state.cadence];
  const addonsCost = ADDONS.reduce((sum, a) => (state.addons.includes(a.key) ? sum + a.price : sum), 0);
  const total = base + rolesCost + storesCost + cadenceCost + addonsCost;
  const closest = total < 3250 ? 'closest to Pilot' : total < 6500 ? 'closest to Team' : 'Studio territory';

  return {
    base, rolesCost, storesCost, cadenceCost, addonsCost, total, closest,
    roleCount: `${state.roles} of 10`,
    storeCount: state.stores === 1 ? 'one store' : `${state.stores} stores`,
    lines: [
      { label: 'Platform and board', value: money(base) },
      { label: `${state.roles} roles on shift`, value: money(rolesCost) },
      {
        label: state.stores === 1 ? 'Single store' : `${state.stores - 1} extra stores`,
        value: money(storesCost),
      },
      { label: `${state.cadence} review gate`, value: cadenceCost ? money(cadenceCost) : 'included' },
      { label: 'Add-ons', value: addonsCost ? money(addonsCost) : 'none' },
    ],
  };
}
