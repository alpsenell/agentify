/** Small formatting helpers shared by the views. */
import { AGENTS, AGENT_IDS, type AgentId, type Sender, type Store, type TaskSummary } from '../../agency/types';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

/** "now", "5m", "3h", "2d", then a date. */
export function ago(at: number, now = Date.now()): string {
  const d = Math.max(0, now - at);
  if (d < MIN) return 'now';
  if (d < HOUR) return `${Math.floor(d / MIN)}m`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h`;
  if (d < 7 * DAY) return `${Math.floor(d / DAY)}d`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const fullDate = (at: number) =>
  new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const isAgent = (s: string): s is AgentId => (AGENT_IDS as readonly string[]).includes(s);

export function senderName(from: Sender, you = 'You'): string {
  if (from === 'client') return you;
  if (from === 'system') return 'Agentify';
  return AGENTS[from].name;
}

/** Who acts next: an agent (working right now, or up next), the client, nobody, or the team is paused. */
export type Actor =
  | { kind: 'agent'; id: AgentId; running: boolean }
  | { kind: 'you'; approval: boolean }
  | { kind: 'paused' }
  | { kind: 'none' };

export function nextActor(t: TaskSummary): Actor {
  if (t.paused && !t.archived && t.waiting === 'agents') return { kind: 'paused' };
  if (t.nextAgent) return { kind: 'agent', id: t.nextAgent, running: t.running };
  if (t.waiting === 'client' || t.waiting === 'gate') return { kind: 'you', approval: t.waiting === 'gate' };
  return { kind: 'none' };
}

/** Which list group a task belongs to. */
export type Group = 'needs' | 'progress' | 'done' | 'archived';

export function groupOf(t: TaskSummary): Group {
  if (t.archived) return 'archived';
  if (t.waiting === 'client' || t.waiting === 'gate') return 'needs';
  if (t.waiting === 'agents') return 'progress';
  return 'done';
}

const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 } as const;

/** Stable row order: priority, then newest request first. Refreshes never shuffle equal rows. */
export const byPriority = (a: TaskSummary, b: TaskSummary) =>
  PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.number - a.number;

/** Strip Markdown to a one-line preview. */
export function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#~|]/g, '')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Match a task against a search query: title, number or last message. */
export function matches(t: TaskSummary, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  if (s.replace(/^#/, '') === String(t.number)) return true;
  return t.title.toLowerCase().includes(s) || (t.lastMessage?.text.toLowerCase().includes(s) ?? false);
}

/** The store a request is for, when the workspace has more than one (otherwise there is nothing to tell apart). */
export function storeFor(stores: Store[], storeId: string | null): Store | null {
  if (stores.length < 2 || !storeId) return null;
  return stores.find((s) => s.id === storeId) ?? null;
}

export const ENV_LABEL = { development: 'Development', staging: 'Staging', production: 'Production' } as const;
