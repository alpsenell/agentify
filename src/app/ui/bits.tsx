/** Small presentational pieces shared by list, board, sidebar and team. */
import { AGENTS, PHASE_LABEL, type Phase, type Priority, type Store, type TaskSummary } from '../../agency/types';
import { ENV_LABEL, nextActor } from './format';
import { Icon } from './Icon';
import './ui.css';

export function PhaseDot({ phase }: { phase: Phase }) {
  return <span className="phase-dot" data-phase={phase} title={PHASE_LABEL[phase]} aria-hidden="true" />;
}

export function PhasePill({ phase }: { phase: Phase }) {
  return <span className="pill" data-phase={phase}>{PHASE_LABEL[phase]}</span>;
}

export const PRIORITY_LABEL: Record<Priority, string> = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' };

export function PriorityFlag({ priority, showNormal = false }: { priority: Priority; showNormal?: boolean }) {
  if (priority === 'normal' && !showNormal) return null;
  return (
    <span className="prio" data-priority={priority} title={`${PRIORITY_LABEL[priority]} priority`}>
      <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 22V3h13l-2 4.5L17 12H4" fill="currentColor" /></svg>
      <span>{PRIORITY_LABEL[priority]}</span>
    </span>
  );
}

/** Who acts next on a task: an agent avatar and name, "You", or "—". */
export function NextActor({ task, compact = false }: { task: TaskSummary; compact?: boolean }) {
  const actor = nextActor(task);
  if (actor.kind === 'agent') {
    const a = AGENTS[actor.id];
    const status = actor.running ? 'is working on it now' : 'is up next';
    return (
      <span className="actor" data-running={actor.running} title={`${a.name} (${a.role}) ${status}`}>
        <span className="avatar small" data-who={a.id} aria-hidden="true">{a.name[0]}</span>
        {!compact && <span className="actor-name">{a.name}</span>}
        {actor.running && <span className="actor-live" aria-hidden="true" />}
        <span className="sr-only">{compact ? `${a.name} ` : ''}{status}</span>
      </span>
    );
  }
  if (actor.kind === 'paused') {
    return (
      <span className="actor paused" title="Paused: the team starts the next step when you resume it">
        <Icon name="pause" size={13} />
        {compact ? <span className="sr-only">Paused</span> : <span className="actor-name">Paused</span>}
      </span>
    );
  }
  if (actor.kind === 'you') {
    return (
      <span className="actor you" title={actor.approval ? 'Waiting for your approval' : 'Waiting for your reply'}>
        <span className="avatar small" data-who="client" aria-hidden="true">Y</span>
        {!compact && <span className="actor-name">{actor.approval ? 'You · approve' : 'You'}</span>}
        {compact && <span className="sr-only">You</span>}
      </span>
    );
  }
  return <span className="actor none">—</span>;
}

/** Which store a request is for: a small tag with the environment as a coloured dot. */
export function StoreTag({ store, compact = false }: { store: Store; compact?: boolean }) {
  return (
    <span className="store-tag" data-env={store.env} title={`${store.label} · ${ENV_LABEL[store.env]}`}>
      <span className="store-tag-dot" aria-hidden="true" />
      <span className={compact ? 'sr-only' : 'store-tag-text'}>{store.label}</span>
    </span>
  );
}

/** The environment of a store, as a tag. */
export function EnvTag({ env }: { env: Store['env'] }) {
  return <span className="tag env-tag" data-env={env}>{ENV_LABEL[env]}</span>;
}
