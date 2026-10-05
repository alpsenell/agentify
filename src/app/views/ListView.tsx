/**
 * The request list (/dashboard): requests grouped by what they wait on,
 * "Needs you" first, in dense ClickUp-style rows. Rows open the request;
 * priority and archive are inline actions on hover.
 */
import { useState } from 'react';
import { PHASES, PHASE_LABEL, PRIORITIES, type Phase, type Store, type TaskSummary } from '../../agency/types';
import { linkClick, paths } from '../router';
import { patchTask } from '../state';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import { NextActor, PhaseDot, PhasePill, PriorityFlag, StoreTag } from '../ui/bits';
import { ENV_LABEL, ago, byPriority, fullDate, groupOf, matches, plain, senderName, storeFor, type Group } from '../ui/format';
import { EXAMPLES } from '../shell/NewRequest';
import './views.css';

interface Props {
  tasks: TaskSummary[] | null;
  error: string | null;
  query: string;
  phase: Phase | 'all';
  onPhase: (p: Phase | 'all') => void;
  stores: Store[];
  /** A store id, or 'all'. */
  store: string;
  onStore: (id: string) => void;
  onNew: (prefill?: string) => void;
  onClearSearch: () => void;
}

const GROUPS: { id: Group; label: string; hint: string }[] = [
  { id: 'needs', label: 'Needs you', hint: 'An answer or an approval from you moves these on' },
  { id: 'progress', label: 'In progress', hint: 'The agents are working on these' },
  { id: 'done', label: 'Done', hint: 'Shipped or finished' },
  { id: 'archived', label: 'Archived', hint: 'Hidden from the board and sidebar' },
];

const FOLD_KEY = 'agentify:list-folded';
function readFolded(): Group[] {
  try { return JSON.parse(localStorage.getItem(FOLD_KEY) ?? '["archived"]') as Group[]; } catch { return ['archived']; }
}

export function ListView({ tasks, error, query, phase, onPhase, stores, store, onStore, onNew, onClearSearch }: Props) {
  const [folded, setFolded] = useState<Group[]>(readFolded);
  const toggle = (g: Group) => setFolded((f) => {
    const next = f.includes(g) ? f.filter((x) => x !== g) : [...f, g];
    try { localStorage.setItem(FOLD_KEY, JSON.stringify(next)); } catch { /* not remembered */ }
    return next;
  });

  if (error && tasks === null) {
    return (
      <div className="view empty fade-in" role="alert">
        <h3>Your requests didn't load</h3>
        <p>{error}</p>
      </div>
    );
  }

  const filtering = query.trim() !== '' || phase !== 'all' || store !== 'all';
  const visible = (tasks ?? []).filter((t) => matches(t, query) && (phase === 'all' || t.phase === phase) && (store === 'all' || t.storeId === store));

  return (
    <div className="view list-view">
      <div className="list-toolbar">
        <Menu
          label="Filter by phase" align="start" heading="Phase"
          triggerClassName={`btn small ${phase === 'all' ? 'ghost' : ''}`}
          trigger={<><Icon name="filter" size={13} /> {phase === 'all' ? 'All phases' : PHASE_LABEL[phase]}</>}
          items={[
            { key: 'all', label: 'All phases', checked: phase === 'all', onSelect: () => onPhase('all') },
            ...PHASES.map((p) => ({ key: p, label: <><PhaseDot phase={p} /> {PHASE_LABEL[p]}</>, checked: phase === p, onSelect: () => onPhase(p) })),
          ]}
        />
        <StoreFilter stores={stores} store={store} onStore={onStore} />
        {filtering && tasks && (
          <span className="list-count fade-in">{visible.length} of {tasks.length}
            <button type="button" className="btn ghost small" onClick={onClearSearch}>Clear</button>
          </span>
        )}
      </div>

      {tasks === null ? <ListSkeleton /> : tasks.length === 0 ? <FirstRequest onNew={onNew} /> : visible.length === 0 ? (
        <div className="empty fade-in">
          <h3>No requests match</h3>
          <p>Try another word, a request number like #4, or clear the filters.</p>
          <button type="button" className="btn" onClick={onClearSearch}>Clear filters</button>
        </div>
      ) : (
        <div className="groups">
          <div className="list-head" aria-hidden="true">
            <span>#</span><span>Request</span><span>Phase</span><span>Next</span><span>Latest</span><span>Priority</span><span>Updated</span><span />
          </div>
          {GROUPS.map((g) => {
            const rows = visible.filter((t) => groupOf(t) === g.id).sort(byPriority);
            if (rows.length === 0) return null;
            const open = !folded.includes(g.id);
            return (
              <section key={g.id} className="group" data-group={g.id} aria-label={g.label}>
                <button type="button" className="group-head" aria-expanded={open} onClick={() => toggle(g.id)} title={g.hint}>
                  <Icon name="chevron" size={12} className="group-caret" />
                  <span className="group-label">{g.label}</span>
                  <span className="group-count">{rows.length}</span>
                  <span className="group-hint">{g.hint}</span>
                </button>
                <div className="group-body" data-open={open}>
                  <ul className="rows" inert={!open}>
                    {rows.map((t) => <Row key={t.id} task={t} store={storeFor(stores, t.storeId)} />)}
                  </ul>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Filter by store; only shown when the workspace has more than one. */
export function StoreFilter({ stores, store, onStore }: { stores: Store[]; store: string; onStore: (id: string) => void }) {
  if (stores.length < 2) return null;
  const current = stores.find((s) => s.id === store);
  return (
    <Menu
      label="Filter by store" align="start" heading="Store"
      triggerClassName={`btn small ${current ? '' : 'ghost'}`}
      trigger={<><Icon name="store" size={13} /> <span className="filter-label">{current ? current.label : 'All stores'}</span></>}
      items={[
        { key: 'all', label: 'All stores', checked: !current, onSelect: () => onStore('all') },
        ...stores.map((s) => ({
          key: s.id, checked: s.id === store, onSelect: () => onStore(s.id),
          label: <><StoreTag store={s} compact /> {s.label} <span className="menu-meta">{ENV_LABEL[s.env]}</span></>,
        })),
      ]}
    />
  );
}

function Row({ task: t, store }: { task: TaskSummary; store: Store | null }) {
  const last = t.lastMessage;
  return (
    <li className="row fade-in" data-needs={groupOf(t) === 'needs'}>
      <span className="row-num mono">#{t.number}</span>
      <a className="row-title" href={paths.task(t.id)} onClick={linkClick}>
        <PhaseDot phase={t.phase} />
        <span className="row-title-text">{t.title}</span>
        {store && <StoreTag store={store} />}
      </a>
      <span className="row-phase"><PhasePill phase={t.phase} /></span>
      <span className="row-next"><NextActor task={t} /></span>
      <span className="row-last">
        {last ? <><strong>{senderName(last.from)}:</strong> {plain(last.text)}</> : <em>No messages yet</em>}
      </span>
      <span className="row-prio"><PriorityFlag priority={t.priority} /></span>
      <time className="row-time" dateTime={new Date(t.updatedAt).toISOString()} title={fullDate(t.updatedAt)}>{ago(t.updatedAt)}</time>
      <span className="row-actions">
        <Menu
          label={`Priority of #${t.number}`} heading="Priority"
          trigger={<Icon name="flag" size={14} />} triggerClassName="btn ghost icon small"
          items={PRIORITIES.slice().reverse().map((p) => ({
            key: p, checked: t.priority === p,
            label: <PriorityFlag priority={p} showNormal />,
            onSelect: () => { if (p !== t.priority) void patchTask(t.id, { priority: p }); },
          }))}
        />
        <button
          type="button" className="btn ghost icon small"
          aria-label={t.archived ? `Restore #${t.number}` : `Archive #${t.number}`} title={t.archived ? 'Restore' : 'Archive'}
          onClick={() => void patchTask(t.id, { archived: !t.archived })}
        >
          <Icon name={t.archived ? 'unarchive' : 'archive'} size={14} />
        </button>
      </span>
    </li>
  );
}

function ListSkeleton() {
  return (
    <div className="groups" aria-busy="true" aria-label="Loading requests">
      <div className="group-head skel"><span className="skeleton" style={{ width: 90, height: 12 }} /></div>
      {[64, 48, 72, 40, 56].map((w, i) => (
        <div key={i} className="row skel">
          <span className="skeleton" style={{ width: 28, height: 10 }} />
          <span className="skeleton" style={{ width: `${w}%`, height: 12 }} />
          <span className="skeleton row-phase" style={{ width: 80, height: 18, borderRadius: 999 }} />
        </div>
      ))}
    </div>
  );
}

/** The empty state: sell the first request. */
function FirstRequest({ onNew }: { onNew: (prefill?: string) => void }) {
  return (
    <div className="first fade-in">
      <div className="first-avatars" aria-hidden="true">
        {['atlas', 'forge', 'muse', 'volt', 'sieve', 'relay'].map((a, i) => (
          <span key={a} className="avatar" data-who={a} style={{ animationDelay: `${i * 60}ms` }}>{a[0]!.toUpperCase()}</span>
        ))}
      </div>
      <h2>Your team is ready for its first request</h2>
      <p>Describe a change to your Shopify store in plain words. Atlas turns it into a brief, the team designs, builds and tests it, and you approve it before anything ships.</p>
      <button type="button" className="btn primary large" onClick={() => onNew()}><Icon name="plus" /> New request</button>
      <div className="first-examples">
        <span className="hint">Or start from one of these</span>
        {EXAMPLES.map((ex) => (
          <button key={ex.label} type="button" className="first-example" onClick={() => onNew(ex.text)}>
            <strong>{ex.label}</strong>
            <span>{ex.text}</span>
            <Icon name="arrow" size={14} />
          </button>
        ))}
      </div>
    </div>
  );
}
