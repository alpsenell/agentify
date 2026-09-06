/**
 * Data behind the Console (home) page. Every figure, name and line of copy
 * comes from the design source (Agentify Console.dc.html). Figures are
 * illustrative and anonymised across active pilots.
 */

export const COLOR = {
  mag: '#c2410c',
  magLight: '#e8845c',
  orangeText: '#b81200',
  orangeMark: '#e0350f',
  humanLog: '#ff9c80',
} as const;

/* ── the team ───────────────────────────────────────────────────────── */

export interface TeamMember {
  num: string;
  role: string;
  name: string;
  stage: string;
  short: string;
  brief: string;
  outputs: string[];
}

export const TEAM: TeamMember[] = [
  { num: '01', role: 'Product', name: 'Atlas', stage: 'intake', short: 'Turns the goal into a scoped, ordered ticket queue.',
    brief: 'Reads the store, the analytics and your goal, then writes the tickets: scope, acceptance criteria, priority and which agents are on it. Nothing enters the pipeline without an Atlas ticket.',
    outputs: ['ticket queue', 'acceptance criteria', 'sprint order'] },
  { num: '02', role: 'Design', name: 'Muse', stage: 'design', short: 'Lays out the page and specs every state.',
    brief: 'Takes the ticket and produces layout, states and spacing against your existing design language — not a fresh look every time. Hands the frontend agent a spec, not a picture.',
    outputs: ['layout spec', 'component states', 'redlines'] },
  { num: '03', role: 'Copy', name: 'Quill', stage: 'content', short: 'Writes the words in your voice, not ours.',
    brief: 'Product copy, PDP descriptions, section headings, microcopy and error states — held against a versioned brand voice profile and checked against product specs for false claims.',
    outputs: ['PDP copy', 'microcopy', 'claim check'] },
  { num: '04', role: 'SEO', name: 'Beacon', stage: 'content', short: 'Keeps structure and metadata legible to search.',
    brief: 'Owns metadata, internal linking, schema and collection structure. Reviews every Quill and Muse output before it ships for anything that would cost you organic traffic.',
    outputs: ['metadata', 'schema', 'link graph'] },
  { num: '05', role: 'Frontend', name: 'Volt', stage: 'build', short: 'Builds the theme code and the states.',
    brief: 'Implements the spec in your theme: Liquid, sections, CSS, interaction states, accessibility and breakpoints. Opens a branch, never edits live.',
    outputs: ['theme branch', 'section code', 'a11y pass'] },
  { num: '06', role: 'Backend', name: 'Forge', stage: 'build', short: 'Wires apps, APIs and data plumbing.',
    brief: 'Admin API work, app integrations, webhooks, metafields and the glue between your store and everything around it. Writes the migration and the rollback together.',
    outputs: ['API work', 'metafields', 'rollback plan'] },
  { num: '07', role: 'QA', name: 'Sieve', stage: 'quality', short: 'Tries to break it before a customer does.',
    brief: 'Runs the acceptance criteria as tests across devices and a real checkout path, plus visual regression against the last shipped build. Fails the ticket back with a repro, not an opinion.',
    outputs: ['test run', 'visual diff', 'repro steps'] },
  { num: '08', role: 'Data', name: 'Ledger', stage: 'quality', short: 'Decides whether it actually worked.',
    brief: 'Instruments the change, sets the success metric before launch, then reports the read after. Kills its own team’s work when the number says so.',
    outputs: ['metric plan', 'post-launch read', 'kill call'] },
  { num: '09', role: 'Deploy', name: 'Relay', stage: 'ship', short: 'Ships it, watches it, rolls it back.',
    brief: 'Merges, deploys behind a flag, watches error and conversion rates for the first hour, and reverts without asking if either moves the wrong way.',
    outputs: ['deploy', 'flag rollout', 'auto-revert'] },
  { num: '10', role: 'Human', name: 'You', stage: 'gate', short: 'The last gate. Nothing ships past you.',
    brief: 'Every ticket stops here as a diff with the reasoning attached. Approve, edit or reject. You can auto-approve categories once you trust them — and revoke that in one click.',
    outputs: ['approve', 'edit', 'reject'] },
];

export const roleColor = (role: string) => (role === 'Human' ? COLOR.orangeText : COLOR.mag);

/* ── pipeline graph (canvas in the design → build-time SVG here) ─────── */

export const EDGES: [number, number][] = [
  [0, 1], [0, 2], [0, 3], [1, 4], [2, 4], [3, 4], [1, 5], [4, 6], [5, 6], [6, 7], [7, 8], [8, 9],
];
const LAYERS = [[0], [1, 2, 3], [4, 5], [6, 7], [8], [9]];

export const GRAPH_W = 1000;
export const GRAPH_H = 520;
const PAD_X = 78;
const PAD_Y = 62;

export interface GraphNode { i: number; x: number; y: number; leftPct: number; topPct: number }

const round = (n: number) => Math.round(n * 100) / 100;

export const NODES: GraphNode[] = (() => {
  const out: GraphNode[] = [];
  LAYERS.forEach((layer, li) => {
    const x = PAD_X + (li * (GRAPH_W - PAD_X * 2)) / (LAYERS.length - 1);
    layer.forEach((idx, ri) => {
      const y = PAD_Y + ((ri + 0.5) * (GRAPH_H - PAD_Y * 2)) / layer.length;
      out[idx] = {
        i: idx,
        x: round(x),
        y: round(y),
        leftPct: round((x / GRAPH_W) * 100),
        topPct: round((y / GRAPH_H) * 100),
      };
    });
  });
  return out;
})();

/** Cubic bezier between two nodes, matching the canvas draw in the design. */
export function edgePath([a, b]: [number, number]): string {
  const A = NODES[a];
  const B = NODES[b];
  const mx = round((A.x + B.x) / 2);
  return `M${A.x} ${A.y}C${mx} ${A.y} ${mx} ${B.y} ${B.x} ${B.y}`;
}

/* ── hero ───────────────────────────────────────────────────────────── */

export const READOUTS = [
  { value: '10', label: 'agents on the team' },
  { value: '11 min', label: 'ticket to shipped diff' },
  { value: '14 d', label: 'pilot, then cancel anytime' },
  { value: '100%', label: 'gated by a human' },
];

export const BAND = [
  { value: '1,412', label: 'tickets closed on client stores this quarter' },
  { value: '11 min', label: 'median ticket to shipped diff' },
  { value: '38', label: 'experiments concluded, 11 shipped' },
  { value: '0', label: 'deploys without human approval' },
];

export const HERO_TRACK = [
  { role: 'Atlas', text: 'Scoped: "PDP add-to-cart is buried on mobile"', dur: '0.4s' },
  { role: 'Muse', text: 'Spec: sticky ATC bar, 3 states, 44px target', dur: '6.1s' },
  { role: 'Volt', text: 'Branch pushed: sticky-atc, 2 sections touched', dur: '8.8s' },
  { role: 'Sieve', text: 'Passed 14 checks, 1 visual diff flagged', dur: '5.2s' },
  { role: 'You', text: 'Awaiting approval — diff ready to review', dur: '—' },
];

export const ACTION_COUNT = 1412;

/* ── console views ──────────────────────────────────────────────────── */

export const VIEWS = [
  { key: 'pipeline', label: 'Pipeline' },
  { key: 'board', label: 'Board' },
  { key: 'timeline', label: 'Timeline' },
  { key: 'log', label: 'Log' },
  { key: 'org', label: 'Org' },
  { key: 'route', label: 'Route' },
] as const;

export const DEFAULT_VIEW = 'pipeline';

/* ── board ──────────────────────────────────────────────────────────── */

export const COLUMNS = ['Intake', 'Design + copy', 'Build', 'QA + data', 'Gate'];

export interface Card { id: number; title: string; pts: string; col: number }

export const CARDS: Card[] = [
  { id: 1, title: 'Sticky add-to-cart on mobile PDP', pts: '3 pts', col: 2 },
  { id: 2, title: 'Rewrite 46 thin product descriptions', pts: '8 pts', col: 1 },
  { id: 3, title: 'Collection filter performance', pts: '5 pts', col: 2 },
  { id: 4, title: 'Back-in-stock flow segments', pts: '3 pts', col: 3 },
  { id: 5, title: 'Q4 gift-guide landing page', pts: '13 pts', col: 1 },
  { id: 6, title: 'Schema markup on 88 collections', pts: '2 pts', col: 4 },
  { id: 7, title: 'Checkout drop-off investigation', pts: '5 pts', col: 3 },
  { id: 8, title: 'Retire 14 sub-margin SKUs', pts: '1 pt', col: 0 },
  { id: 9, title: 'Bundle upsell on cart drawer', pts: '8 pts', col: 0 },
];

export const LANE_OWNERS = [['Atlas'], ['Muse', 'Quill', 'Beacon'], ['Volt', 'Forge'], ['Sieve', 'Ledger'], ['You']];

export const cardAgent = (id: number, col: number) => {
  const roster = LANE_OWNERS[col];
  return roster[id % roster.length];
};

export const BACKLOG = [
  { title: 'Size guide overlay on apparel PDPs', pts: '3 pts' },
  { title: 'Duplicate SKUs in the sale collection', pts: '2 pts' },
  { title: 'Klaviyo welcome flow is misfiring', pts: '5 pts' },
  { title: 'Search returns nothing for plurals', pts: '5 pts' },
  { title: 'Free-shipping threshold in cart drawer', pts: '3 pts' },
  { title: 'Product images 2.4MB on mobile', pts: '8 pts' },
  { title: 'Reviews widget blocks first paint', pts: '5 pts' },
  { title: 'Wholesale pricing on tagged accounts', pts: '13 pts' },
  { title: 'Gift-note field lost at checkout', pts: '3 pts' },
  { title: 'Variant swatches wrong on two collections', pts: '2 pts' },
  { title: 'Abandoned-cart copy is four years old', pts: '5 pts' },
  { title: 'Currency selector resets on navigation', pts: '5 pts' },
  { title: 'Bundle discount not stacking with tiers', pts: '8 pts' },
  { title: 'Blog templates missing article schema', pts: '2 pts' },
  { title: 'Preorder badge shows on in-stock items', pts: '3 pts' },
  { title: 'Checkout upsell slows first paint', pts: '5 pts' },
];

/* ── timeline ───────────────────────────────────────────────────────── */

export interface GanttBar { start: number; len: number; label: string }
export interface GanttRow { role: string; bars: GanttBar[] }

export const GANTT: GanttRow[] = [
  { role: 'Atlas', bars: [{ start: 0, len: 8, label: 'scope + tickets' }] },
  { role: 'Muse', bars: [{ start: 7, len: 18, label: 'layout spec' }] },
  { role: 'Quill', bars: [{ start: 10, len: 20, label: 'copy pass' }] },
  { role: 'Beacon', bars: [{ start: 26, len: 12, label: 'metadata' }] },
  { role: 'Volt', bars: [{ start: 24, len: 26, label: 'theme build' }] },
  { role: 'Forge', bars: [{ start: 28, len: 20, label: 'api + metafields' }] },
  { role: 'Sieve', bars: [{ start: 49, len: 16, label: 'test run' }] },
  { role: 'Ledger', bars: [{ start: 62, len: 14, label: 'metric plan' }] },
  { role: 'Relay', bars: [{ start: 76, len: 10, label: 'deploy + watch' }] },
  { role: 'You', bars: [{ start: 86, len: 12, label: 'approve' }] },
];

export const DEFAULT_PLAYHEAD = 22;
export const TIMELINE_DAYS = 14;

/** Bars sit near the right edge, so their label flips to the left of the bar. */
export const barNearRight = (b: GanttBar) => b.start + b.len > 74;
export const barState = (b: GanttBar, playhead: number): 'past' | 'live' | 'future' =>
  playhead >= b.start + b.len ? 'past' : playhead >= b.start ? 'live' : 'future';

/* ── log ────────────────────────────────────────────────────────────── */

export const LOG: [string, string][] = [
  ['atlas', 'ticket #4192 created — "mobile ATC buried on PDP"'],
  ['atlas', 'assigned muse, volt, sieve · priority p1 · 3 pts'],
  ['muse', 'read design language v7, 2 existing sticky patterns found'],
  ['muse', 'spec written: 3 states, 44px target, safe-area inset'],
  ['quill', 'microcopy: "Add — $48" / "Added" / "Sold out"'],
  ['volt', 'branch sticky-atc created from main'],
  ['volt', 'sections/product-atc.liquid +148 −12'],
  ['volt', 'a11y: focus order and aria-live verified'],
  ['sieve', 'running 14 acceptance checks across 6 devices'],
  ['sieve', '13 passed · 1 visual diff on iPhone SE — flagged'],
  ['volt', 'fixed: overlap with cart drawer at 375px'],
  ['sieve', 'all 14 checks passed · visual diff clean'],
  ['ledger', 'metric set: mobile ATC rate, 7-day read, min lift 3%'],
  ['relay', 'queued behind flag atc_sticky at 50% exposure'],
  ['human', 'awaiting your approval — diff and reasoning attached'],
];

export const DEFAULT_LOG_STEP = 4;

/* ── route ──────────────────────────────────────────────────────────── */

export const TASKS = [
  { title: 'Our mobile PDP converts half as well as desktop', kind: 'problem' },
  { title: 'Launch a Q4 gift guide by November 1', kind: 'project' },
  { title: 'Checkout errors spiked yesterday', kind: 'incident' },
];

export const ROUTES: number[][] = [
  [0, 1, 4, 6, 8, 9],
  [0, 1, 2, 3, 4, 6, 9],
  [0, 5, 6, 8, 9],
];

export const ROUTE_NOTES: [string, string][] = [
  ['Atlas', 'Scoped into 3 tickets — sticky ATC, image weight, form length.'],
  ['Muse', 'Spec for the sticky bar, reusing the existing button system.'],
  ['Volt', 'Branch pushed, two sections touched, behind a flag.'],
  ['Sieve', 'Fourteen checks across six devices — one diff, then clean.'],
  ['Relay', 'Deployed at 50% exposure, watching error and ATC rate.'],
  ['You', 'Diff ready. Approve, edit or reject.'],
  ['Ledger', 'Metric set before launch: mobile ATC rate, 7-day read.'],
  ['Quill', 'Copy pass against the brand voice profile.'],
  ['Beacon', 'Metadata and schema checked before ship.'],
  ['Forge', 'API path traced, rollback written alongside the fix.'],
];

export const routeNote = (idx: number): [string, string] =>
  ROUTE_NOTES.find((n) => n[0] === TEAM[idx].name) ?? [TEAM[idx].name, 'Picked up the ticket.'];

/* ── the delta / access / queries ───────────────────────────────────── */

export const COMPARE = [
  { label: 'Turnaround on a copy change', them: '3–5 business days', us: 'Under 15 minutes' },
  { label: 'Hours available per month', them: '40 retainer hours', us: 'Continuous, ten roles' },
  { label: 'Who does the work', them: 'Whoever is unbooked', us: 'The same specialists' },
  { label: 'Testing cadence', them: '1–2 tests a quarter', us: 'A live queue, always on' },
  { label: 'Reporting', them: 'A deck, monthly', us: 'A live log of every action' },
  { label: 'Cost of scope creep', them: 'A change order', us: 'None' },
];

export interface Tier {
  kicker: string;
  price: string;
  unit: string;
  cta: string;
  slots: string;
  featured?: boolean;
  features: string[];
}

export const TIERS: Tier[] = [
  { kicker: 'Pilot', price: '$4,500', unit: 'per month · one store', cta: 'Open a pilot', slots: '4 slots',
    features: ['Four agents of your choice', 'Weekly human review', 'Full pipeline log and diffs', 'Two-week exit, no notice'] },
  { kicker: 'Team', price: '$9,800', unit: 'per month · one store', cta: 'Talk to us', slots: '2 slots', featured: true,
    features: ['All ten roles on shift', 'Daily review, same-day ship', 'Experiment queue always running', 'Plus and headless ready', 'Shared Slack channel'] },
  { kicker: 'Studio', price: 'Custom', unit: 'multi-store · white label', cta: 'Request scope', slots: 'by intake',
    features: ['Multiple stores or brands', 'White-label for agencies', 'Custom agents on your playbooks', 'Dedicated planner and SLA'] },
];

export const FAQS = [
  { q: 'Do the agents push to my live store on their own?', a: 'No. Relay deploys only what a human approved, behind a flag, and reverts automatically if error or conversion rates move the wrong way. You can auto-approve low-risk categories once you trust them.' },
  { q: 'What happens when an agent gets something wrong?', a: 'Sieve catches most of it and fails the ticket back with a repro. Anything that gets past QA is caught at your gate, and the correction is written into the agent’s playbook so it does not queue twice.' },
  { q: 'Is this cheaper than a retainer agency?', a: 'Usually — but cadence is the real difference. Work that used to wait for the next sprint happens the same day, every day, and you can see every action in the log.' },
  { q: 'Can we keep our existing developer?', a: 'Yes, and most clients do. They keep a developer for custom platform work and let the team own the continuous operating layer around it.' },
];

export const DEFAULT_FAQ = 0;
