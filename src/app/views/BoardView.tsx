/**
 * The board (/dashboard/board): the same requests as columns by phase. The
 * agents move cards, not the client, so there is no drag-and-drop; each
 * column header names who owns that phase.
 */
import { AGENTS, PHASES, PHASE_LABEL, type Phase, type Store, type TaskSummary } from '../../agency/types';
import { linkClick, paths } from '../router';
import { Icon } from '../ui/Icon';
import { NextActor, PhaseDot, PriorityFlag, StoreTag } from '../ui/bits';
import { ago, byPriority, groupOf, matches, plain, senderName, storeFor } from '../ui/format';
import { StoreFilter } from './ListView';
import './views.css';

interface Props {
  tasks: TaskSummary[] | null;
  error: string | null;
  query: string;
  stores: Store[];
  store: string;
  onStore: (id: string) => void;
  onNew: (prefill?: string) => void;
}

/** Who owns each phase, shown in the column header. */
function owner(phase: Phase): { who: string; name: string; role: string } | null {
  if (phase === 'gate') return { who: 'client', name: 'You', role: 'Approve or return' };
  const agent = Object.values(AGENTS).find((a) => a.phase === phase);
  return agent ? { who: agent.id, name: agent.name, role: agent.role } : null;
}

export function BoardView({ tasks, error, query, stores, store, onStore, onNew }: Props) {
  if (error && tasks === null) {
    return <div className="view empty fade-in" role="alert"><h3>Your requests didn't load</h3><p>{error}</p></div>;
  }
  const visible = (tasks ?? []).filter((t) => !t.archived && matches(t, query) && (store === 'all' || t.storeId === store));

  return (
    <div className="board-wrap">
      <div className="board-note">
        <StoreFilter stores={stores} store={store} onStore={onStore} />
        <span className="board-note-text"><Icon name="spark" size={13} /> Cards move on their own as each agent hands the work to the next.</span>
      </div>
      <div className="board" role="list" aria-label="Requests by phase" aria-busy={tasks === null}>
        {PHASES.map((phase) => {
          const cards = visible.filter((t) => t.phase === phase).sort(byPriority);
          const own = owner(phase);
          return (
            <section key={phase} className="col" data-phase={phase} role="listitem" aria-label={`${PHASE_LABEL[phase]}: ${cards.length}`}>
              <header className="col-head">
                <div className="col-title">
                  <PhaseDot phase={phase} />
                  <h2>{PHASE_LABEL[phase]}</h2>
                  <span className="col-count">{tasks === null ? '–' : cards.length}</span>
                </div>
                {own && (
                  <div className="col-owner" title={`${own.name}, ${own.role}`}>
                    <span className="avatar small" data-who={own.who} aria-hidden="true">{own.name[0]}</span>
                    <span>{own.name} · {own.role}</span>
                  </div>
                )}
              </header>
              <ul className="col-cards">
                {tasks === null && phase === 'discovery' && [0, 1].map((i) => <li key={i} className="card-skel skeleton" />)}
                {cards.map((t) => <Card key={t.id} task={t} store={storeFor(stores, t.storeId)} />)}
                {tasks !== null && cards.length === 0 && phase === 'discovery' && visible.length === 0 && (
                  <li className="col-empty">
                    <button type="button" className="btn small" onClick={() => onNew()}><Icon name="plus" size={13} /> New request</button>
                  </li>
                )}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function Card({ task: t, store }: { task: TaskSummary; store: Store | null }) {
  const last = t.lastMessage;
  const needs = groupOf(t) === 'needs';
  return (
    <li className="bcard fade-in" data-needs={needs}>
      <a href={paths.task(t.id)} onClick={linkClick} className="bcard-link">
        <span className="bcard-top">
          <span className="mono bcard-num">#{t.number}</span>
          <PriorityFlag priority={t.priority} />
          {needs && <span className="tag" data-tone="accent">{t.waiting === 'gate' ? 'Approve' : 'Reply'}</span>}
        </span>
        <span className="bcard-title">{t.title}</span>
        {store && <span className="bcard-store"><StoreTag store={store} /></span>}
        {last && <span className="bcard-last"><strong>{senderName(last.from)}:</strong> {plain(last.text)}</span>}
        <span className="bcard-foot">
          <NextActor task={t} />
          <span className="bcard-time">{ago(t.updatedAt)}</span>
        </span>
      </a>
    </li>
  );
}
