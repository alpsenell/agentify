/**
 * The task header: number, editable title, priority, the store it is for,
 * the pipeline (who owns each phase and where the work is) and the
 * pause/resume control.
 */
import { useEffect, useRef, useState } from 'react';
import { AGENTS, PHASE_LABEL, PRIORITIES, type Priority, type Store, type Task } from '../../agency/types';
import { useLive, type LiveStore } from './live';
import { STAGES, stageState } from './format';
import { toast } from '../ui/toast';
import type { RunStatus } from './useTaskRunner';

const PRIORITY_LABEL: Record<Priority, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };

function TitleField({ task, readOnly, onSave }: { task: Task; readOnly: boolean; onSave: (title: string) => Promise<string | null> }) {
  const [value, setValue] = useState(task.title);
  const [error, setError] = useState<string | null>(null);
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setValue(task.title); }, [task.title]);

  const commit = async () => {
    editing.current = false;
    const next = value.trim();
    if (!next) { setValue(task.title); return; }
    if (next === task.title) return;
    const err = await onSave(next);
    setError(err);
    if (err) setValue(task.title);
  };

  return (
    <div className="tv-title-wrap">
      <input
        className="tv-title"
        value={value}
        readOnly={readOnly}
        aria-label="Request title"
        maxLength={160}
        onFocus={() => { editing.current = true; }}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') { e.stopPropagation(); setValue(task.title); editing.current = false; requestAnimationFrame(() => e.currentTarget?.blur()); }
        }}
      />
      {error && <span className="error-text" role="alert">{error}</span>}
    </div>
  );
}

function Pipeline({ task, status, live }: { task: Task; status: RunStatus; live: LiveStore }) {
  const { agent } = useLive(live);
  const working = status === 'running';
  return (
    <ol className="tv-pipe" aria-label="Pipeline">
      {STAGES.map((s, i) => {
        const state = task.phase === 'done' ? 'done' : stageState(s, task.phase);
        const active = state === 'current' && (s.who === 'client' ? task.waiting === 'gate' : working && (!agent || agent === s.who));
        const owner = s.who === 'client' ? 'you' : `${AGENTS[s.who].name}, ${AGENTS[s.who].role}`;
        return (
          <li key={s.phase} className="tv-pipe-step" data-state={state} data-active={active || undefined} data-who={s.who}>
            {i > 0 && <span className="tv-pipe-line" aria-hidden="true" />}
            <span className="tv-pipe-chip" title={`${PHASE_LABEL[s.phase]} · ${owner}`}>
              <span className="avatar small" data-who={s.who} aria-hidden="true">{state === 'done' ? '✓' : s.name[0]}</span>
              <span className="tv-pipe-name">{s.name}</span>
            </span>
            <span className="sr-only">
              {PHASE_LABEL[s.phase]}, {owner}: {state === 'done' ? 'done' : state === 'current' ? 'current' : 'upcoming'}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

const ENV_TONE: Record<Store['env'], string> = { production: 'danger', staging: 'warn', development: 'info' };

function StoreTag({ stores, storeId }: { stores: Store[]; storeId: string | null }) {
  if (!stores.length) return null;
  const store = stores.find((s) => s.id === storeId);
  if (!store) return <span className="tag" title="This request is not tied to a store">No store</span>;
  return (
    <span className="tv-store" title={store.shopify ? `${store.shopify.shopName} (${store.shopify.domain})` : 'Not connected to Shopify'}>
      <span className="sr-only">Store: </span>
      <span className="tv-store-label">{store.label}</span>
      <span className="tag" data-tone={ENV_TONE[store.env]}>{store.env}</span>
    </span>
  );
}

interface HeaderProps {
  task: Task;
  stores: Store[];
  status: RunStatus;
  due: boolean;
  canRun: boolean;
  live: LiveStore;
  onPause: (paused: boolean) => Promise<string | null>;
  onUpdate: (patch: { title?: string; priority?: Priority }) => Promise<string | null>;
}

export function Header({ task, stores, status, due, canRun, live, onPause, onUpdate }: HeaderProps) {
  const working = status === 'running';
  const paused = task.paused;
  const showChain = canRun && !task.archived && (working || due || paused);
  return (
    <header className="tv-head">
      <div className="tv-head-row">
        <span className="tv-num">#{task.number}</span>
        <TitleField task={task} readOnly={task.archived} onSave={(title) => onUpdate({ title })} />
      </div>
      <div className="tv-head-row tv-head-meta">
        <label className="tv-priority" data-priority={task.priority}>
          <span className="sr-only">Priority</span>
          <span className="tv-priority-dot" aria-hidden="true" />
          <select
            value={task.priority}
            disabled={task.archived}
            onChange={async (e) => {
              const err = await onUpdate({ priority: e.target.value as Priority });
              if (err) toast(`Couldn't change the priority: ${err}`, 'danger');
            }}
          >
            {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
          </select>
        </label>
        <StoreTag stores={stores} storeId={task.storeId} />
        {task.archived && <span className="tag">Archived · read-only</span>}
        <span className="tv-head-spacer" />
        {showChain && (
          <span className="tv-chain">
            <span className="tv-chain-state" data-on={working && !paused ? 'true' : undefined} data-paused={paused || undefined}>
              {working ? (paused ? 'Pausing after this step' : 'Team working') : paused ? 'Paused' : 'Starting'}
            </span>
            <button type="button" className="btn small" aria-pressed={paused} onClick={async () => {
              const err = await onPause(!paused);
              if (err) toast(`Couldn't ${paused ? 'resume' : 'pause'}: ${err}`, 'danger');
            }}>
              {paused ? (
                <><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1l7 4-7 4z" fill="currentColor" /></svg> Resume</>
              ) : (
                <><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1h2v8H2zM6 1h2v8H6z" fill="currentColor" /></svg> Pause</>
              )}
            </button>
          </span>
        )}
      </div>
      <Pipeline task={task} status={status} live={live} />
    </header>
  );
}
