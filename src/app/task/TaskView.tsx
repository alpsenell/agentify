/**
 * One request: the client talks with the team and watches them work. Content
 * panels on the left, the conversation on the right (tabs when narrow). The
 * app shell renders this inside its sheet for /dashboard/t/:id.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AGENTS, type Attachment, type Me, type Task } from '../../agency/types';
import { Composer } from './Composer';
import { tokens } from './format';
import { GateBar } from './Gate';
import { Header } from './Header';
import { PANEL_LABEL, PanelContent, availablePanels, panelBadge, type PanelId } from './panels';
import { Thread } from './Thread';
import { upNext, useTaskRunner, type TaskRunner } from './useTaskRunner';
import './task.css';

type TabId = PanelId | 'thread';

/** Below this container width the two columns become tabs. */
const NARROW_PX = 880;

interface Props {
  taskId: string;
  me: Me;
  onClose: () => void;
  onTaskChanged: (task: Task) => void;
}

function composerCopy(task: Task, runner: TaskRunner, llmReady: boolean): { hint: string; placeholder: string } {
  const last = task.messages.at(-1);
  const next = upNext(task);
  if (runner.status === 'running') {
    return {
      hint: task.paused ? 'Pausing — the step already running finishes first.' : 'The team is working — you can still add a note.',
      placeholder: 'Add a note for the team…',
    };
  }
  if (runner.status === 'failed' || last?.kind === 'error') {
    return { hint: 'A step failed. Retry it, or add detail that might help.', placeholder: 'Add detail for the team…' };
  }
  if (task.waiting === 'gate') {
    return { hint: 'Approve or return the build above, or ask a question first.', placeholder: 'Ask the team about this build…' };
  }
  if (task.phase === 'done') {
    return { hint: 'Done. Describe a change and Atlas will pick it up.', placeholder: 'Describe a change…' };
  }
  if (task.waiting === 'client' && last && last.from !== 'client' && last.from !== 'system') {
    const who = AGENTS[last.from].name;
    return { hint: `${who} asked you a question.`, placeholder: `Reply to ${who}…` };
  }
  if (next && (runner.paused || !llmReady)) {
    return {
      hint: runner.paused ? `Paused — ${AGENTS[next].name} continues when you resume.` : 'Messages are saved; the team picks them up once the agents are set up.',
      placeholder: 'Add a note for the team…',
    };
  }
  return { hint: 'Message the team.', placeholder: 'Write a message…' };
}

function Skeleton() {
  return (
    <div className="tv tv-loading" aria-busy="true" aria-label="Loading request">
      <div className="tv-head">
        <div className="skeleton" style={{ width: '45%', height: 22 }} />
        <div className="skeleton" style={{ width: '70%', height: 26, marginTop: 14 }} />
      </div>
      <div className="tv-skel-body">
        {[70, 52, 80, 40].map((w, i) => (
          <div key={i} className="tv-skel-row">
            <div className="skeleton" style={{ width: 28, height: 28, borderRadius: '50%' }} />
            <div style={{ flex: 1 }}>
              <div className="skeleton" style={{ width: '30%', height: 12 }} />
              <div className="skeleton" style={{ width: `${w}%`, height: 14, marginTop: 8 }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Tabs({ tabs, active, fresh, task, onSelect, label }: {
  tabs: TabId[]; active: TabId; fresh: ReadonlySet<TabId>; task: Task; onSelect: (id: TabId) => void; label: string;
}) {
  const refs = useRef(new Map<TabId, HTMLButtonElement>());
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.indexOf(active);
    const to = e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length]
      : e.key === 'ArrowLeft' ? tabs[(i - 1 + tabs.length) % tabs.length]
      : e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs.at(-1) : undefined;
    if (!to) return;
    e.preventDefault();
    onSelect(to);
    refs.current.get(to)?.focus();
  };
  return (
    <div className="tv-tabs" role="tablist" aria-label={label} onKeyDown={onKey}>
      {tabs.map((id) => {
        const badge = id === 'thread' ? null : panelBadge(task, id);
        return (
          <button
            key={id}
            ref={(el) => { if (el) refs.current.set(id, el); else refs.current.delete(id); }}
            type="button"
            role="tab"
            id={`tv-tab-${id}`}
            aria-selected={id === active}
            aria-controls={`tv-tabpanel-${id === 'thread' ? 'thread' : 'panel'}`}
            tabIndex={id === active ? 0 : -1}
            className={`tv-tab${fresh.has(id) ? ' is-fresh' : ''}`}
            onClick={() => onSelect(id)}
          >
            {id === 'thread' ? 'Conversation' : PANEL_LABEL[id]}
            {badge && <span className="tv-tab-badge" data-tone={badge.tone}>{badge.text}</span>}
            {fresh.has(id) && <span className="tv-tab-dot" aria-label="new" />}
          </button>
        );
      })}
    </div>
  );
}

export default function TaskView({ taskId, me, onClose, onTaskChanged }: Props) {
  const runner = useTaskRunner(taskId, me, onTaskChanged);
  const { task, load } = runner;
  const rootRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [panel, setPanel] = useState<PanelId>('overview');
  const [narrowTab, setNarrowTab] = useState<TabId>('thread');
  const [fresh, setFresh] = useState<ReadonlySet<TabId>>(() => new Set());
  const [stickKey, setStickKey] = useState(0);
  const seen = useRef<Set<PanelId> | null>(null);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setNarrow((entry?.contentRect.width ?? 1000) < NARROW_PX));
    ro.observe(el);
    return () => ro.disconnect();
  }, [load]);

  const panels = useMemo(() => (task ? availablePanels(task) : []), [task]);

  // A panel that appears mid-session gets a highlight instead of taking focus.
  useEffect(() => {
    if (!task) return;
    if (!seen.current) { seen.current = new Set(panels); return; }
    // A new brief resets later artifacts: forget them so they highlight again when they return.
    for (const p of [...seen.current]) if (!panels.includes(p)) seen.current.delete(p);
    setFresh((f) => { const kept = [...f].filter((p) => p === 'thread' || panels.includes(p as PanelId)); return kept.length === f.size ? f : new Set(kept); });
    const added = panels.filter((p) => !seen.current!.has(p));
    if (!added.length) return;
    added.forEach((p) => seen.current!.add(p));
    setFresh((f) => new Set([...f, ...added]));
  }, [panels, task]);

  useEffect(() => { seen.current = null; setPanel('overview'); setNarrowTab('thread'); setFresh(new Set()); }, [taskId]);

  const select = useCallback((id: TabId) => {
    if (id === 'thread') setNarrowTab('thread');
    else { setPanel(id); setNarrowTab(id); }
    setFresh((f) => { if (!f.has(id)) return f; const n = new Set(f); n.delete(id); return n; });
  }, []);

  const openPanel = useCallback((id: PanelId) => select(id), [select]);

  if (load === 'loading' && !task) return <div className="tv-host" ref={rootRef}><Skeleton /></div>;
  if (load === 'notFound') {
    return (
      <div className="tv-host" ref={rootRef}>
        <div className="tv tv-state">
          <div className="empty">
            <h3>Request not found</h3>
            <p>It may have been deleted, or it belongs to another workspace.</p>
            <button type="button" className="btn" onClick={onClose}>Back to requests</button>
          </div>
        </div>
      </div>
    );
  }
  if (load === 'error' && !task) {
    return (
      <div className="tv-host" ref={rootRef}>
        <div className="tv tv-state">
          <div className="empty">
            <h3>Couldn't load this request</h3>
            <p>{runner.loadError}</p>
            <div className="tv-chips">
              <button type="button" className="btn primary" onClick={() => void runner.reload()}>Try again</button>
              <button type="button" className="btn" onClick={onClose}>Close</button>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (!task) return <div className="tv-host" ref={rootRef}><Skeleton /></div>;

  const activePanel = panels.includes(panel) ? panel : 'overview';
  const { hint, placeholder } = composerCopy(task, runner, me.llmReady);
  const showGate = task.phase === 'gate' && task.waiting === 'gate' && !task.archived;
  const send = async (text: string, attachments: Attachment[]) => {
    const err = await runner.send(text, attachments);
    if (!err) setStickKey((k) => k + 1);
    return err;
  };

  const conversation = (
    <section className="tv-side" id="tv-tabpanel-thread" role={narrow ? 'tabpanel' : 'region'} aria-label="Conversation"
      hidden={narrow && narrowTab !== 'thread'}>
      <Thread runner={runner} task={task} me={me} stickKey={stickKey} onOpenPanel={openPanel} />
      <div className="tv-dock">
        {showGate && <GateBar task={task} onDecide={runner.decide} onOpenPanel={openPanel} />}
        {task.archived ? (
          <p className="tv-readonly">This request is archived and read-only.</p>
        ) : (
          <Composer taskId={task.id} hint={hint} placeholder={placeholder} onSend={send} />
        )}
      </div>
    </section>
  );

  const content = (current: PanelId) => (
    <div className="tv-panel-scroll" id="tv-tabpanel-panel" role="tabpanel" aria-labelledby={`tv-tab-${current}`} tabIndex={0}>
      <div key={current} className="tv-panel-anim fade-in">
        <PanelContent id={current} task={task} onOpen={openPanel} />
      </div>
    </div>
  );

  return (
    <div className="tv-host" ref={rootRef}>
      <div className="tv" data-narrow={narrow || undefined}>
        <Header
          task={task}
          stores={me.workspace.stores ?? []}
          status={runner.status}
          due={runner.due || task.paused}
          canRun={me.llmReady}
          live={runner.live}
          onPause={runner.setPaused}
          onUpdate={runner.update}
        />
        {narrow ? (
          <div className="tv-body is-narrow">
            <Tabs tabs={['thread', ...panels]} active={narrowTab === 'thread' ? 'thread' : activePanel} fresh={fresh} task={task} onSelect={select} label="Request sections" />
            {conversation}
            {narrowTab !== 'thread' && content(activePanel)}
          </div>
        ) : (
          <div className="tv-body">
            <section className="tv-main" aria-label="Details">
              <Tabs tabs={panels} active={activePanel} fresh={fresh} task={task} onSelect={select} label="Request details" />
              {content(activePanel)}
            </section>
            {conversation}
          </div>
        )}
        <footer className="tv-foot">
          <span title="Tokens used by every agent step on this request">
            {tokens(task.usage.input)} in · {tokens(task.usage.output)} out tokens
          </span>
          {task.paused && <span className="tag" data-tone="warn">Paused</span>}
          {runner.status === 'running' && <span className="tv-foot-live"><span className="spinner" aria-hidden="true" /> live</span>}
        </footer>
        <div className="sr-only" role="status" aria-live="polite">{runner.announcement}</div>
      </div>
    </div>
  );
}
