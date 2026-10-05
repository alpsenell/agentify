/** Small formatting helpers shared by the task view. */
import { AGENTS, PHASES, type AgentId, type Message, type Phase, type Sender } from '../../agency/types';

export function senderName(who: Sender | Message['to']): string {
  if (who === 'client') return 'You';
  if (who === 'system') return 'Agentify';
  if (who === 'team') return 'Team';
  return AGENTS[who].name;
}

export function senderRole(who: Sender): string {
  if (who === 'client') return 'Client';
  if (who === 'system') return 'System';
  return AGENTS[who].role;
}

export const initial = (who: Sender) => (who === 'client' ? 'Y' : who === 'system' ? 'A' : AGENTS[who].name[0]!);

export function timeOf(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

export const fullTime = (at: number) => new Date(at).toLocaleString();

export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/* ── the pipeline, as the client sees it ── */

export interface Stage {
  phase: Phase;
  who: AgentId | 'client';
  name: string;
}

export const STAGES: Stage[] = [
  { phase: 'discovery', who: 'atlas', name: 'Atlas' },
  { phase: 'feasibility', who: 'forge', name: 'Forge' },
  { phase: 'design', who: 'muse', name: 'Muse' },
  { phase: 'build', who: 'volt', name: 'Volt' },
  { phase: 'review', who: 'sieve', name: 'Sieve' },
  { phase: 'gate', who: 'client', name: 'You' },
  { phase: 'ship', who: 'relay', name: 'Relay' },
];

export type StageState = 'done' | 'current' | 'todo';

export function stageState(stage: Stage, phase: Phase): StageState {
  const at = PHASES.indexOf(phase);
  const mine = PHASES.indexOf(stage.phase);
  return mine < at ? 'done' : mine === at ? 'current' : 'todo';
}
