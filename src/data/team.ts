/**
 * The ten standing briefs behind the Team page. Copy, figures and stage
 * names come straight from the design source (Team.dc.html); figures are
 * illustrative and anonymised across pilots.
 */

export type Stage = 'intake' | 'design' | 'content' | 'build' | 'quality' | 'ship' | 'gate';

export type ActionStatus = 'shipped' | 'review' | 'blocked' | 'returned' | 'closed';

export interface Metric {
  value: string;
  label: string;
}

export interface Action {
  time: string;
  text: string;
  status: ActionStatus;
}

export interface TeamMember {
  num: string;
  role: string;
  name: string;
  stage: Stage;
  brief: string;
  inputs: string[];
  outputs: string[];
  stop: string;
  metrics: Metric[];
  actions: Action[];
}

const a = (time: string, text: string, status: ActionStatus): Action => ({ time, text, status });

export const TEAM: TeamMember[] = [
  {
    num: '01', role: 'Product', name: 'Atlas', stage: 'intake',
    brief:
      'Reads the store, the analytics and your stated goal, then writes the tickets — scope, acceptance criteria, priority, and which agents are on it. Nothing enters the pipeline without an Atlas ticket, and no agent may widen a ticket it was handed.',
    inputs: ['Store + theme snapshot', '90 days of orders', 'Your goal statement'],
    outputs: ['Ticket queue', 'Acceptance criteria', 'Sprint order'],
    stop: 'Cannot create work above the monthly action budget without your approval.',
    metrics: [
      { value: '184', label: 'tickets written' },
      { value: '91%', label: 'accepted as scoped' },
      { value: '3.1', label: 'median points' },
    ],
    actions: [
      a('09:04', 'Scoped "mobile ATC buried on PDP" into 3 tickets', 'shipped'),
      a('08:41', 'Reprioritised sprint after checkout error spike', 'shipped'),
      a('08:12', 'Rejected own ticket #4188 as duplicate', 'closed'),
      a('07:55', 'Flagged 14 sub-margin SKUs for retirement', 'review'),
      a('07:30', 'Drafted Q4 gift-guide epic, 6 tickets', 'review'),
    ],
  },
  {
    num: '02', role: 'Design', name: 'Muse', stage: 'design',
    brief:
      'Takes a ticket and produces layout, states and spacing against your existing design language — not a fresh look every time. Hands the frontend agent a spec with redlines and every interaction state, not a picture to interpret.',
    inputs: ['Design language v7', 'Existing component set', 'The ticket + criteria'],
    outputs: ['Layout spec', 'Component states', 'Redlines'],
    stop: 'Cannot introduce a new component pattern without a human design review.',
    metrics: [
      { value: '96', label: 'specs delivered' },
      { value: '0', label: 'new patterns unapproved' },
      { value: '1.4', label: 'revisions per spec' },
    ],
    actions: [
      a('09:12', 'Spec: sticky ATC bar, 3 states, 44px target', 'shipped'),
      a('08:50', 'Reused existing button system, no new tokens', 'shipped'),
      a('08:20', 'Requested human review for new drawer pattern', 'review'),
      a('07:48', 'Redlined gift-guide hero at 3 breakpoints', 'shipped'),
      a('07:15', 'Rejected Volt build: focus ring missing', 'returned'),
    ],
  },
  {
    num: '03', role: 'Copy', name: 'Quill', stage: 'content',
    brief:
      'Writes product copy, PDP descriptions, section headings, microcopy and error states — all held against a versioned brand voice profile and checked against product specs so nothing ships a claim the product cannot make.',
    inputs: ['Brand voice profile v7', 'Product specs', 'Search intent data'],
    outputs: ['PDP copy', 'Microcopy', 'Claim check'],
    stop: 'Cannot publish a claim not evidenced in the product spec.',
    metrics: [
      { value: '2,840', label: 'PDPs written' },
      { value: '+31%', label: 'organic entrances' },
      { value: '11', label: 'claims blocked' },
    ],
    actions: [
      a('09:18', 'Microcopy set: "Add — $48" / "Added" / "Sold out"', 'shipped'),
      a('08:44', 'Rewrote 46 thin descriptions in voice', 'review'),
      a('08:03', 'Blocked "clinically proven" — no spec evidence', 'blocked'),
      a('07:36', 'Error states for cart drawer, 4 cases', 'shipped'),
      a('07:02', 'Collection intros for 8 new collections', 'shipped'),
    ],
  },
  {
    num: '04', role: 'SEO', name: 'Beacon', stage: 'content',
    brief:
      'Owns metadata, internal linking, schema and collection structure, and reviews every Quill and Muse output before it ships for anything that would cost you organic traffic — a moved heading, an orphaned collection, a lost canonical.',
    inputs: ['Search console data', 'Site structure map', 'Every content diff'],
    outputs: ['Metadata', 'Schema', 'Link graph'],
    stop: 'Cannot ship a redirect or canonical change without human sign-off.',
    metrics: [
      { value: '88', label: 'collections structured' },
      { value: '+31%', label: 'organic entrances' },
      { value: '4', label: 'traffic risks caught' },
    ],
    actions: [
      a('09:02', 'Schema markup on 88 collection pages', 'review'),
      a('08:38', 'Caught orphaned collection after Muse restructure', 'blocked'),
      a('08:11', 'Internal links added to 46 rewritten PDPs', 'shipped'),
      a('07:40', 'Flagged canonical change for human sign-off', 'review'),
      a('07:05', 'Metadata pass on gift-guide draft', 'shipped'),
    ],
  },
  {
    num: '05', role: 'Frontend', name: 'Volt', stage: 'build',
    brief:
      'Implements the spec in your theme — Liquid, sections, CSS, interaction states, accessibility and breakpoints. Opens a branch, never edits live, and treats a failed QA return as a bug in its own work rather than a disagreement.',
    inputs: ['Muse spec + redlines', 'Theme repository', 'Component library'],
    outputs: ['Theme branch', 'Section code', 'Accessibility pass'],
    stop: 'Cannot merge to main. Ever. Relay merges, humans approve.',
    metrics: [
      { value: '212', label: 'branches pushed' },
      { value: '96%', label: 'first-pass QA' },
      { value: '0', label: 'direct-to-live edits' },
    ],
    actions: [
      a('09:26', 'Branch sticky-atc pushed, 2 sections touched', 'review'),
      a('09:05', 'Fixed overlap with cart drawer at 375px', 'shipped'),
      a('08:32', 'a11y: focus order and aria-live verified', 'shipped'),
      a('08:00', 'Returned to Muse: spec missing empty state', 'returned'),
      a('07:22', 'Collection filter performance, 340ms → 90ms', 'shipped'),
    ],
  },
  {
    num: '06', role: 'Backend', name: 'Forge', stage: 'build',
    brief:
      'Admin API work, app integrations, webhooks, metafields and the glue between your store and everything around it. Writes the migration and the rollback in the same commit — nothing goes out without a documented way back.',
    inputs: ['Admin API scopes', 'App inventory', 'Data model'],
    outputs: ['API work', 'Metafields', 'Rollback plan'],
    stop: 'Cannot write to production data without an accompanying rollback.',
    metrics: [
      { value: '61', label: 'integrations touched' },
      { value: '100%', label: 'with rollback' },
      { value: '2', label: 'reverts used' },
    ],
    actions: [
      a('09:20', 'Back-in-stock flow segments rebuilt', 'review'),
      a('08:47', 'Webhook retry logic for fulfilment gaps', 'shipped'),
      a('08:15', 'Metafield schema for gift-guide bundles', 'shipped'),
      a('07:52', 'Traced checkout error spike to app timeout', 'shipped'),
      a('07:10', 'Rollback rehearsed on staging copy', 'shipped'),
    ],
  },
  {
    num: '07', role: 'QA', name: 'Sieve', stage: 'quality',
    brief:
      'Runs the acceptance criteria as tests across devices and a real checkout path, plus visual regression against the last shipped build. Fails a ticket back with a reproduction, never an opinion, and cannot be overruled by the agent that wrote the code.',
    inputs: ['Acceptance criteria', 'Last shipped build', 'Device matrix'],
    outputs: ['Test run', 'Visual diff', 'Repro steps'],
    stop: 'A failed check blocks the ticket. Only a human can override.',
    metrics: [
      { value: '1,204', label: 'checks run' },
      { value: '38', label: 'tickets failed back' },
      { value: '6', label: 'devices per run' },
    ],
    actions: [
      a('09:31', 'All 14 checks passed · visual diff clean', 'shipped'),
      a('09:08', '13 passed · 1 visual diff on iPhone SE', 'blocked'),
      a('08:36', 'Real checkout path walked, 3 currencies', 'shipped'),
      a('08:04', 'Failed #4187 back to Volt with repro', 'returned'),
      a('07:28', 'Regression suite refreshed against main', 'shipped'),
    ],
  },
  {
    num: '08', role: 'Data', name: 'Ledger', stage: 'quality',
    brief:
      'Instruments the change, sets the success metric before launch, then reports the read afterwards — and calls its own team’s work dead when the number says so. The only agent allowed to recommend a revert on evidence alone.',
    inputs: ['Analytics + funnel data', 'The ticket goal', 'Post-launch cohorts'],
    outputs: ['Metric plan', 'Post-launch read', 'Kill call'],
    stop: 'Cannot change a metric definition after launch.',
    metrics: [
      { value: '38', label: 'experiments read' },
      { value: '11', label: 'shipped as winners' },
      { value: '9', label: 'killed on data' },
    ],
    actions: [
      a('09:35', 'Metric set: mobile ATC rate, 7-day read, min 3%', 'shipped'),
      a('08:58', 'Called #4180 dead: −1.2% at 95%', 'closed'),
      a('08:24', 'Checkout drop-off investigation opened', 'review'),
      a('07:58', 'Cohort read on gift-guide traffic', 'shipped'),
      a('07:19', 'Instrumented cart drawer events', 'shipped'),
    ],
  },
  {
    num: '09', role: 'Deploy', name: 'Relay', stage: 'ship',
    brief:
      'Merges, deploys behind a flag, watches error and conversion rates for the first hour, and reverts without asking if either moves the wrong way. The only agent with merge rights, and it only uses them on an approved diff.',
    inputs: ['Approved diff', 'Flag configuration', 'Live error + conversion feed'],
    outputs: ['Deploy', 'Flag rollout', 'Auto-revert'],
    stop: 'Will not deploy anything without a recorded human approval.',
    metrics: [
      { value: '148', label: 'deploys' },
      { value: '99.4%', label: 'clean first hour' },
      { value: '2', label: 'auto-reverts' },
    ],
    actions: [
      a('09:40', 'Queued behind flag atc_sticky at 50%', 'review'),
      a('09:00', 'Deployed #4189, first hour clean', 'shipped'),
      a('08:30', 'Auto-reverted #4184 on error rate +0.8%', 'closed'),
      a('07:59', 'Rolled flag gift_guide to 100%', 'shipped'),
      a('07:12', 'Held deploy: no human approval on file', 'blocked'),
    ],
  },
  {
    num: '10', role: 'Human', name: 'You', stage: 'gate',
    brief:
      'Every ticket stops here as a diff with the reasoning attached — what changed, why, what it is measured against, and what happens if it fails. Approve, edit or reject. You can auto-approve whole categories once you trust them, and revoke that in one click.',
    inputs: ['The diff', 'The reasoning', 'The metric plan'],
    outputs: ['Approve', 'Edit', 'Reject'],
    stop: 'Nothing ships past this gate without you, or a rule you wrote.',
    metrics: [
      { value: '11 min', label: 'median review' },
      { value: '94%', label: 'approved as built' },
      { value: '6%', label: 'edited or rejected' },
    ],
    actions: [
      a('09:42', 'Approved sticky ATC at 50% exposure', 'shipped'),
      a('09:10', 'Edited copy on 4 of 46 descriptions', 'shipped'),
      a('08:35', 'Rejected new drawer pattern, off-brand', 'closed'),
      a('08:02', 'Auto-approve enabled for metadata changes', 'shipped'),
      a('07:30', 'Requested rollback rehearsal before Forge merge', 'review'),
    ],
  },
];

/** Stage filter chips, in design order. */
export const STAGES: ReadonlyArray<'all' | Stage> = [
  'all', 'intake', 'design', 'content', 'build', 'quality', 'ship', 'gate',
];

/** Status colours for the "last actions" log. */
export const STATUS_COLOR: Record<ActionStatus, string> = {
  shipped: 'var(--ink)',
  review: 'var(--mag)',
  blocked: 'var(--orange-text)',
  returned: 'var(--orange-text)',
  closed: 'var(--mute)',
};

/** The Human role reads orange; every agent role reads magenta. */
export const roleColor = (m: TeamMember): string =>
  m.role === 'Human' ? 'var(--orange-text)' : 'var(--mag)';

/** Slug used for ids and data hooks (agent names are unique). */
export const slug = (m: TeamMember): string => m.name.toLowerCase();
