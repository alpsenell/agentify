/** Data behind the Contact (intake) page. */
export interface Role {
  key: string;
  name: string;
  short: string;
  locked?: boolean;
}

export const ROLES: Role[] = [
  { key: 'atlas', name: 'Atlas', short: 'Scopes and prioritises the queue', locked: true },
  { key: 'muse', name: 'Muse', short: 'Layout and interaction specs' },
  { key: 'quill', name: 'Quill', short: 'Copy in your brand voice' },
  { key: 'beacon', name: 'Beacon', short: 'Metadata, schema, structure' },
  { key: 'volt', name: 'Volt', short: 'Theme code and states' },
  { key: 'forge', name: 'Forge', short: 'Apps, APIs, metafields' },
  { key: 'sieve', name: 'Sieve', short: 'Tests across devices and checkout' },
  { key: 'ledger', name: 'Ledger', short: 'Metrics before and after' },
  { key: 'relay', name: 'Relay', short: 'Deploys, watches, reverts' },
  { key: 'you', name: 'You', short: 'The human gate, always on', locked: true },
];

/** Roles pre-selected when the form loads (the usual four-agent pilot plus the two locked ones). */
export const DEFAULT_PICKED = ['atlas', 'muse', 'volt', 'sieve', 'you'];

export const BANDS = ['pre-launch', 'under $1M', '$1–10M', '$10–50M', '$50M+'];
export const DEFAULT_BAND = '$1–10M';

export const STEPS = [
  { num: '01', label: 'the problem' },
  { num: '02', label: 'the roles' },
  { num: '03', label: 'review' },
];

export const PROMISES = [
  'A written pilot scope, not a proposal deck',
  'The ticket queue Atlas drafted, in full',
  'Which agents are assigned and why',
  'What ships in week one, and how it is measured',
];
