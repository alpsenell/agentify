/** Data behind the Process page: seven stages, one walkthrough ticket, three gates. */
import { COLOR } from './live';

export interface Stage {
  num: string;
  label: string;
  owner: string;
  title: string;
  dur: string;
  body: string;
  enters: string;
  leaves: string;
  gateKind: string;
  gate: string;
  failures: string[];
}

export const STAGES: Stage[] = [
  { num: '01', label: 'Intake', owner: 'Atlas', title: 'Intake', dur: '4 min',
    body: 'A goal, a complaint or a number that moved becomes a ticket: scope, acceptance criteria, priority and the agents assigned. Atlas writes it, and no downstream agent is allowed to widen it.',
    enters: 'A goal, an anomaly, or a request from you', leaves: 'A scoped ticket with acceptance criteria',
    gateKind: 'budget gate', gate: 'Work above the monthly action budget needs your approval before it enters the queue.',
    failures: ['Ambiguous goal is returned to you with three concrete options', 'Duplicate of an open ticket is closed on sight', 'Out-of-scope request becomes a new ticket, never a bigger one'] },
  { num: '02', label: 'Design', owner: 'Muse', title: 'Design', dur: '18 min',
    body: 'Layout, states and spacing against your existing design language. The output is a spec with redlines and every interaction state — not a picture for the build agent to interpret.',
    enters: 'A scoped ticket', leaves: 'A layout spec with all states redlined',
    gateKind: 'human gate', gate: 'A new component pattern cannot be introduced without a human design review.',
    failures: ['Missing state (empty, error, loading) is caught and the spec is returned', 'A pattern that already exists is reused instead of invented', 'Off-brand direction is rejected at your gate, not after build'] },
  { num: '03', label: 'Content', owner: 'Quill + Beacon', title: 'Content', dur: '20 min',
    body: 'Copy in your voice, checked against product specs, with metadata and structure reviewed for anything that would cost organic traffic. Two agents work the same ticket and can block each other.',
    enters: 'A layout spec with copy slots', leaves: 'Copy, microcopy, metadata and schema',
    gateKind: 'evidence gate', gate: 'A claim not evidenced in the product spec is blocked and never reaches the build.',
    failures: ['Unsupported claim is stripped and flagged to you', 'Heading change that orphans a collection is reverted by Beacon', 'Voice drift is caught against the versioned profile'] },
  { num: '04', label: 'Build', owner: 'Volt + Forge', title: 'Build', dur: '26 min',
    body: 'The spec becomes theme code and API work on a branch. Accessibility, breakpoints and interaction states are part of the definition of done, and every data change ships with its rollback.',
    enters: 'A spec plus approved copy', leaves: 'A branch, a rollback plan, an a11y pass',
    gateKind: 'hard rule', gate: 'No build agent can merge to main. Relay merges, and only an approved diff.',
    failures: ['Missing spec detail is returned to Muse rather than guessed', 'A change without a rollback is blocked by Forge itself', 'Accessibility regression fails its own pre-check'] },
  { num: '05', label: 'Quality', owner: 'Sieve + Ledger', title: 'Quality', dur: '16 min',
    body: 'Acceptance criteria run as tests across six devices and a real checkout path, plus visual regression against the last shipped build. Ledger sets the success metric here, before anything goes live.',
    enters: 'A branch claiming to be done', leaves: 'A test run, a visual diff, a metric plan',
    gateKind: 'blocking gate', gate: 'A failed check blocks the ticket. Only a human can override, and the override is logged.',
    failures: ['Failed check goes back to the build agent with a repro, not an opinion', 'Visual diff outside tolerance halts the ticket', 'No measurable success metric means it does not ship'] },
  { num: '06', label: 'Gate', owner: 'You', title: 'Human gate', dur: '11 min',
    body: 'The ticket arrives as a diff with the reasoning attached: what changed, why, what it is measured against, and what happens if it fails. Approve, edit or reject.',
    enters: 'A tested diff with a metric plan', leaves: 'An approval, an edit, or a rejection',
    gateKind: 'you', gate: 'Nothing ships past this point without you — or a rule you wrote and can revoke in one click.',
    failures: ['Rejection returns the ticket with your note attached to the agent brief', 'An edit is applied and the diff is re-tested before ship', 'No response holds the ticket; nothing ships by timeout'] },
  { num: '07', label: 'Ship', owner: 'Relay', title: 'Ship + watch', dur: '10 min',
    body: 'Merge, deploy behind a flag, then watch error and conversion rates for the first hour. If either moves the wrong way, Relay reverts without asking and reopens the ticket.',
    enters: 'An approved diff', leaves: 'A live change under watch, or a clean revert',
    gateKind: 'auto-revert', gate: 'Error rate or conversion moving the wrong way triggers a revert inside the first hour.',
    failures: ['Auto-revert fires and the ticket reopens with the live data attached', 'Flag stays at partial exposure until the read is clean', 'Ledger calls the change dead at the 7-day read and it is rolled back'] },
];

export interface WalkStep {
  time: string;
  agent: string;
  text: string;
  tag: string;
  /** Index into STAGES that this step belongs to. */
  stage: number;
}

export const WALK: WalkStep[] = [
  { time: '09:04', agent: 'Atlas', text: 'Ticket #4192: mobile ATC buried on PDP. 3 pts, p1.', tag: 'intake', stage: 0 },
  { time: '09:12', agent: 'Muse', text: 'Spec: sticky ATC bar, 3 states, 44px target, safe-area inset.', tag: 'design', stage: 1 },
  { time: '09:18', agent: 'Quill', text: 'Microcopy: "Add — $48" / "Added" / "Sold out".', tag: 'content', stage: 2 },
  { time: '09:26', agent: 'Volt', text: 'Branch sticky-atc pushed. 2 sections, +148 −12.', tag: 'build', stage: 3 },
  { time: '09:31', agent: 'Sieve', text: '13 of 14 checks passed. Visual diff on iPhone SE.', tag: 'returned', stage: 4 },
  { time: '09:35', agent: 'Volt', text: 'Fixed overlap with cart drawer at 375px.', tag: 'build', stage: 3 },
  { time: '09:38', agent: 'Sieve', text: 'All 14 checks passed. Visual diff clean.', tag: 'quality', stage: 4 },
  { time: '09:40', agent: 'Ledger', text: 'Metric set: mobile ATC rate, 7-day read, min lift 3%.', tag: 'quality', stage: 4 },
  { time: '09:42', agent: 'You', text: 'Approved at 50% exposure.', tag: 'gate', stage: 5 },
  { time: '09:44', agent: 'Relay', text: 'Deployed behind flag atc_sticky. Watching first hour.', tag: 'ship', stage: 6 },
];

export interface Gate {
  num: string;
  title: string;
  tint: string;
  body: string;
}

export const GATES: Gate[] = [
  { num: '01', title: 'Evidence', tint: COLOR.magLight, body: 'No claim without a spec to back it, no ship without a metric to judge it. Agents that cannot show the evidence do not pass the ticket on.' },
  { num: '02', title: 'Peer block', tint: COLOR.magLight, body: 'QA can fail the build agent. SEO can block the copy agent. Data can kill the whole team’s work. No agent can overrule the one that blocked it.' },
  { num: '03', title: 'You', tint: '#ff9c80', body: 'The last gate is a person. Every diff, every reasoning trail, every rollback plan lands with you before it touches a customer.' },
];

export const TAG_COLOR: Record<string, string> = {
  intake: COLOR.mag, design: COLOR.mag, content: COLOR.mag, build: COLOR.mag, quality: COLOR.mag,
  gate: COLOR.orangeText, ship: COLOR.ink, returned: COLOR.orangeText,
};

export const agentColor = (agent: string) => (agent === 'You' ? COLOR.orangeText : COLOR.mag);
