/**
 * Data behind the Live board. Figures are illustrative and anonymised
 * across pilots, exactly as in the design source.
 */

export const COLOR = {
  ink: '#16130f',
  mute: '#6b655c',
  mag: '#c2410c',
  magLight: '#e8845c',
  orange: '#ff3d17',
  orangeDeep: '#9c1206',
  orangeText: '#b81200',
  idle: '#c9c2b7',
} as const;

export type AgentStatus =
  | 'scoping' | 'specing' | 'writing' | 'building' | 'testing'
  | 'reading' | 'watching' | 'blocking' | 'at gate';

export interface Agent {
  name: string;
  status: AgentStatus;
  /** 0..1 */
  load: number;
  tickets: number;
  throughput: string;
  task: string;
}

export interface Lane {
  num: string;
  name: string;
  mode: string;
  wip: number;
  note: string;
  agents: Agent[];
}

export const LANES: Lane[] = [
  { num: '01', name: 'Intake', mode: 'conducts', wip: 6, note: 'writes the tickets every lane pulls from',
    agents: [
      { name: 'Atlas', status: 'scoping', load: 0.62, tickets: 6, throughput: '12/h', task: 'Splitting "mobile converts at half of desktop" into three tickets.' },
    ] },
  { num: '02', name: 'Content', mode: 'parallel ×3', wip: 9, note: 'three agents, same ticket, blocking rights on each other',
    agents: [
      { name: 'Muse', status: 'specing', load: 0.78, tickets: 4, throughput: '5/h', task: 'Sticky ATC bar: three states, 44px target, safe-area inset.' },
      { name: 'Quill', status: 'writing', load: 0.91, tickets: 9, throughput: '18/h', task: 'Rewriting 46 thin descriptions against voice profile v7.' },
      { name: 'Beacon', status: 'blocking', load: 0.34, tickets: 3, throughput: '9/h', task: 'Held a heading change that would orphan two collections.' },
    ] },
  { num: '03', name: 'Build', mode: 'parallel ×2', wip: 8, note: 'branches only — no build agent can merge',
    agents: [
      { name: 'Volt', status: 'building', load: 0.86, tickets: 5, throughput: '4/h', task: 'Branch sticky-atc: two sections touched, a11y pass running.' },
      { name: 'Forge', status: 'building', load: 0.55, tickets: 3, throughput: '3/h', task: 'Back-in-stock webhook retry, rollback written alongside.' },
    ] },
  { num: '04', name: 'Quality', mode: 'parallel ×2', wip: 11, note: 'can fail any lane above it back with a repro',
    agents: [
      { name: 'Sieve', status: 'testing', load: 0.72, tickets: 7, throughput: '14/h', task: 'Fourteen acceptance checks across six devices and checkout.' },
      { name: 'Ledger', status: 'reading', load: 0.41, tickets: 4, throughput: '6/h', task: 'Metric set before launch: mobile ATC rate, seven-day read.' },
    ] },
  { num: '05', name: 'Ship + gate', mode: 'serial', wip: 5, note: 'the only lane that touches the live store',
    agents: [
      { name: 'Relay', status: 'watching', load: 0.28, tickets: 2, throughput: '2/h', task: 'Flag atc_sticky at 50%, watching error and conversion rate.' },
      { name: 'You', status: 'at gate', load: 0.19, tickets: 3, throughput: '—', task: 'Three diffs waiting on approval, oldest six hours old.' },
    ] },
];

export const FEED_LINES: ReadonlyArray<readonly [agent: string, text: string]> = [
  ['Volt', 'Branch sticky-atc pushed — 2 sections, +148 −12'],
  ['Sieve', '14 acceptance checks passed across 6 devices'],
  ['Quill', 'Rewrote 12 thin descriptions against voice v7'],
  ['Relay', 'Flag atc_sticky rolled to 50% exposure'],
  ['Ledger', 'Metric set: mobile ATC rate, 7-day read'],
  ['Beacon', 'Blocked heading change — orphans 2 collections'],
  ['Atlas', 'Reprioritised sprint after checkout error spike'],
  ['Forge', 'Webhook retry logic shipped with rollback'],
  ['Muse', 'Spec returned to build: empty state missing'],
  ['You', 'Approved #4189 — deployed at 50%'],
  ['Sieve', 'Failed #4187 back to Volt with repro steps'],
  ['Relay', 'Auto-reverted #4184 on error rate +0.8%'],
];

export type TicketKind = 'live' | 'review' | 'blocked' | 'done';

export interface Ticket {
  id: string;
  title: string;
  owner: string;
  stage: string;
  status: string;
  age: string;
  kind: TicketKind;
}

export const QUEUE: Ticket[] = [
  { id: '#4192', title: 'Sticky add-to-cart on mobile PDP', owner: 'Volt', stage: 'ship', status: 'watching', age: '38 min', kind: 'live' },
  { id: '#4191', title: 'Rewrite 46 thin product descriptions', owner: 'Quill', stage: 'content', status: 'in review', age: '1 h', kind: 'review' },
  { id: '#4190', title: 'Collection filter performance', owner: 'Forge', stage: 'build', status: 'building', age: '2 h', kind: 'live' },
  { id: '#4189', title: 'Back-in-stock flow segments', owner: 'Forge', stage: 'quality', status: 'testing', age: '3 h', kind: 'live' },
  { id: '#4188', title: 'Q4 gift-guide landing page', owner: 'Muse', stage: 'content', status: 'in review', age: '4 h', kind: 'review' },
  { id: '#4187', title: 'Cart drawer overlap at 375px', owner: 'Volt', stage: 'build', status: 'returned', age: '5 h', kind: 'blocked' },
  { id: '#4186', title: 'Schema markup on 88 collections', owner: 'Beacon', stage: 'gate', status: 'awaiting you', age: '6 h', kind: 'review' },
  { id: '#4185', title: 'Checkout drop-off investigation', owner: 'Ledger', stage: 'quality', status: 'reading', age: '8 h', kind: 'live' },
  { id: '#4184', title: 'Bundle upsell on cart drawer', owner: 'Relay', stage: 'ship', status: 'reverted', age: '1 d', kind: 'blocked' },
  { id: '#4183', title: 'Retire 14 sub-margin SKUs', owner: 'Atlas', stage: 'intake', status: 'shipped', age: '1 d', kind: 'done' },
];

export const RANGES = [
  { label: '24 h', days: 1 },
  { label: '7 d', days: 7 },
  { label: '30 d', days: 30 },
] as const;
export type RangeDays = (typeof RANGES)[number]['days'];
export const DEFAULT_RANGE: RangeDays = 1;

export interface Tile {
  key: string;
  seed: number;
  amp: number;
  label: string;
  /** Value shown per range window. */
  values: Record<RangeDays, string>;
  delta: string;
}

export const TILES: Tile[] = [
  { key: 'shipped', seed: 0.4, amp: 0.52, label: 'tickets shipped', values: { 1: '14', 7: '96', 30: '412' }, delta: '+12%' },
  { key: 'median', seed: 2.7, amp: 0.34, label: 'median ticket to ship', values: { 1: '11 min', 7: '13 min', 30: '16 min' }, delta: '−18%' },
  { key: 'blocked', seed: 5.1, amp: 0.62, label: 'blocked at a gate', values: { 1: '3', 7: '19', 30: '74' }, delta: '−6%' },
  { key: 'reverts', seed: 8.3, amp: 0.44, label: 'auto-reverts', values: { 1: '0', 7: '2', 30: '9' }, delta: '0' },
];

export const FILTERS: ReadonlyArray<'all' | TicketKind> = ['all', 'live', 'review', 'blocked'];

export const STATUS_COLOR: Record<string, string> = {
  watching: COLOR.mag, 'in review': COLOR.mag, building: COLOR.ink, testing: COLOR.ink,
  returned: COLOR.orangeText, reverted: COLOR.orangeText, 'awaiting you': COLOR.orangeText,
  reading: COLOR.ink, shipped: COLOR.mute,
};

export const AGENT_STATUS_COLOR: Record<AgentStatus, string> = {
  scoping: COLOR.mag, specing: COLOR.mag, writing: COLOR.mag, building: COLOR.mag, testing: COLOR.mag,
  reading: COLOR.mute, watching: COLOR.mute, blocking: COLOR.orangeText, 'at gate': COLOR.orangeText,
};

export const ON_SHIFT = 10;
export const EVENT_COUNT = 412;
export const IN_FLIGHT = LANES.reduce((t, l) => t + l.wip, 0);

export const isStalled = (a: Agent) => a.status === 'blocking' || a.status === 'at gate';

export const deltaColor = (delta: string) =>
  delta.startsWith('−') ? COLOR.ink : delta === '0' ? COLOR.mute : COLOR.mag;

/** HH:MM in 24-hour local time, matching the design's toTimeString().slice(0, 5). */
export const hhmm = (d: Date) =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
