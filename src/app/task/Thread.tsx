/**
 * The conversation: the client's own exchange with the team, the agents
 * handing work to each other in the open, and the step streaming right now.
 * Sticks to the bottom only while the reader is already there.
 */
import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AGENTS, type AgentId, type Me, type Message, type MessageKind, type Phase, type Task } from '../../agency/types';
import { linkClick, paths } from '../router';
import { MessageAttachments } from './Attachments';
import { useLive, type LiveStore, type ToolLine } from './live';
import { Markdown } from './Markdown';
import { fullTime, initial, senderName, senderRole, timeOf } from './format';
import type { PanelId } from './panels';
import { PHASE_VERB, upNext, type TaskRunner } from './useTaskRunner';

const KIND_META: Partial<Record<MessageKind, { label: string; panel: PanelId; action: string }>> = {
  brief: { label: 'Brief', panel: 'brief', action: 'Open brief' },
  feasibility: { label: 'Feasibility report', panel: 'feasibility', action: 'Open report' },
  spec: { label: 'Design spec', panel: 'design', action: 'Open spec' },
  build: { label: 'Build', panel: 'files', action: 'View files' },
  review: { label: 'QA review', panel: 'review', action: 'Open review' },
  deploy: { label: 'Deploy', panel: 'deploy', action: 'Open deploy' },
};

type Variant = 'client' | 'direct' | 'team' | 'system';

function variantOf(m: Pick<Message, 'from' | 'to'>): Variant {
  if (m.from === 'client') return 'client';
  if (m.from === 'system') return 'system';
  return m.to === 'client' ? 'direct' : 'team';
}

/* ── pieces ──────────────────────────────────────────────────────────── */

export function ToolLines({ tools }: { tools: ToolLine[] }) {
  if (!tools.length) return null;
  return (
    <ul className="tv-tools" aria-label="Activity">
      {tools.map((t) => (
        <li key={t.id} className="tv-tool fade-in" data-state={t.state}>
          <span className="tv-tool-icon" aria-hidden="true">
            {t.state === 'running' ? <span className="spinner" /> : t.state === 'done' ? '✓' : '✕'}
          </span>
          <span className="tv-tool-label">{t.label}</span>
          {t.state === 'failed' && <span className="sr-only">(failed)</span>}
        </li>
      ))}
    </ul>
  );
}

function Header({ from, to, at, extra }: { from: Message['from']; to?: Message['to']; at?: number; extra?: ReactNode }) {
  return (
    <div className="tv-msg-head">
      <span className="tv-msg-name">{senderName(from)}</span>
      {from !== 'client' && <span className="tv-msg-role">{senderRole(from)}</span>}
      {to && to !== 'client' && (
        <span className="tv-msg-to"><span aria-hidden="true">→</span><span className="sr-only">to</span> {senderName(to)}</span>
      )}
      {to === 'client' && from !== 'client' && <span className="tv-msg-to is-you"><span aria-hidden="true">→</span><span className="sr-only">to</span> You</span>}
      {extra}
      {at !== undefined && <time className="tv-msg-time" dateTime={new Date(at).toISOString()} title={fullTime(at)}>{timeOf(at)}</time>}
    </div>
  );
}

export function RetryButton({ onRetry, label = 'Retry' }: { onRetry: () => Promise<string | null>; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="tv-retry">
      <button type="button" className="btn small" disabled={busy} onClick={async () => {
        setBusy(true);
        setError(null);
        const err = await onRetry();
        setBusy(false);
        if (err) setError(err);
      }}>
        {busy ? <span className="spinner" aria-hidden="true" /> : <span aria-hidden="true">↻</span>} {label}
      </button>
      {error && <span className="error-text" role="alert">{error}</span>}
    </span>
  );
}

interface RowProps {
  message: Message;
  tools?: ToolLine[];
  animate: boolean;
  /** Same sender as the row above, moments apart: no repeated header. */
  grouped: boolean;
  isLast: boolean;
  canRetry: boolean;
  onRetry: () => Promise<string | null>;
  onOpenPanel: (panel: PanelId) => void;
}

const MessageRow = memo(function MessageRow({ message: m, tools, animate, grouped, isLast, canRetry, onRetry, onOpenPanel }: RowProps) {
  const variant = variantOf(m);
  const meta = KIND_META[m.kind];

  if (variant === 'system' && m.kind !== 'error') {
    return (
      <li className={`tv-sys${animate ? ' fade-in' : ''}`}>
        <Markdown text={m.text} />
        <time title={fullTime(m.at)}>{timeOf(m.at)}</time>
      </li>
    );
  }

  let body: ReactNode;
  if (m.kind === 'error') {
    const plan = isPlanLimit(m.text);
    body = (
      <div className="tv-card is-error" role="group" aria-label="Step failed">
        <div className="tv-card-head"><span className="tag" data-tone="danger">{plan ? 'Plan limit reached' : 'Step failed'}</span></div>
        <Markdown text={m.text} />
        {isLast && (canRetry || plan) && (
          <div className="tv-card-actions">
            {plan && <a className="btn small primary" href={paths.settings()} onClick={linkClick}>Open Settings → Plan</a>}
            {canRetry && <RetryButton onRetry={onRetry} label={plan ? 'Retry after upgrading' : 'Retry'} />}
          </div>
        )}
      </div>
    );
  } else if (m.kind === 'gate') {
    const head = m.text.slice(0, 80);
    const tone = /approv/i.test(head) ? 'ok' : /return|change/i.test(head) ? 'warn' : undefined;
    body = (
      <div className="tv-card is-gate" data-tone={tone}>
        <div className="tv-card-head">
          <span className="tag" data-tone={tone}>{tone === 'ok' ? 'Approved' : tone === 'warn' ? 'Returned for changes' : 'Decision'}</span>
        </div>
        <Markdown text={m.text} />
      </div>
    );
  } else if (meta) {
    body = (
      <div className="tv-card" data-kind={m.kind}>
        <div className="tv-card-head">
          <span className="tv-card-label">{meta.label}</span>
          <button type="button" className="btn small ghost tv-card-open" onClick={() => onOpenPanel(meta.panel)}>
            {meta.action} <span aria-hidden="true">→</span>
          </button>
        </div>
        <div className="tv-card-clamp"><Markdown text={m.text} /></div>
      </div>
    );
  } else {
    body = m.text ? <Markdown text={m.text} className="tv-msg-text" /> : null;
  }

  return (
    <li className={`tv-msg is-${variant}${grouped ? ' is-grouped' : ''}${animate ? ' fade-in' : ''}`} data-id={m.id}>
      <span className="avatar" data-who={m.from} aria-hidden="true">{grouped ? '' : initial(m.from)}</span>
      <div className="tv-msg-main">
        {!grouped && <Header from={m.from} to={m.to} at={m.at} />}
        {tools && <ToolLines tools={tools} />}
        {body && <div className="tv-msg-body">{body}</div>}
        {m.attachments?.length ? <MessageAttachments attachments={m.attachments} /> : null}
      </div>
    </li>
  );
});

/** A step refused by the workspace's plan (out of tokens, trial over): the fix is in Settings. */
const isPlanLimit = (text: string) => /Settings\s*→\s*Plan/.test(text);

/** Who the streaming message is probably for, so the bubble matches the message it becomes. */
function guessVariant(agent: AgentId, phase: Phase | null): Variant {
  return agent === 'atlas' && (phase === 'discovery' || phase === 'gate' || phase === 'done') ? 'direct' : 'team';
}

function LiveBubble({ store, fallback }: { store: LiveStore; fallback: { agent: AgentId; phase: Phase } | null }) {
  const view = useLive(store);
  // Between the step starting and its first live record, show who is starting.
  const s = view.agent ? view : fallback ? { ...fallback, text: '', tools: [] as ToolLine[] } : null;
  if (!s?.agent) return null;
  const variant = guessVariant(s.agent, s.phase);
  const working = (
    <span className="tv-msg-status">
      {s.phase ? PHASE_VERB[s.phase] : 'working'}
      <span className="typing" aria-hidden="true"><i /><i /><i /></span>
    </span>
  );
  return (
    <li className={`tv-msg is-${variant} is-live fade-in`} aria-busy="true">
      <span className="avatar is-working" data-who={s.agent} aria-hidden="true">{initial(s.agent)}</span>
      <div className="tv-msg-main">
        <Header from={s.agent} extra={working} />
        <ToolLines tools={s.tools} />
        {s.text && <div className="tv-msg-body"><Markdown text={s.text} className="tv-msg-text is-streaming" /></div>}
      </div>
    </li>
  );
}

function Notice({ who, children, tone }: { who?: AgentId | 'system'; children: ReactNode; tone?: 'warn' | 'danger' | 'info' }) {
  return (
    <li className="tv-notice fade-in" data-tone={tone}>
      {who && <span className={`avatar small${who !== 'system' ? ' is-working' : ''}`} data-who={who} aria-hidden="true">{initial(who)}</span>}
      <div className="tv-notice-body">{children}</div>
    </li>
  );
}

/* ── the thread ──────────────────────────────────────────────────────── */

interface ThreadProps {
  runner: TaskRunner;
  task: Task;
  me: Me;
  /** Changes when the client sends: jump to the bottom. */
  stickKey: number;
  onOpenPanel: (panel: PanelId) => void;
}

const GROUP_MS = 5 * 60_000;

export function Thread({ runner, task, me, stickKey, onOpenPanel }: ThreadProps) {
  const { streamed, activity, status, offline, paused, live, retry, setPaused } = runner;
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const lastHeight = useRef(0);
  const [unseen, setUnseen] = useState(false);

  // Messages rendered on first paint don't animate in; everything after does.
  const initialIds = useRef<Set<string> | null>(null);
  initialIds.current ??= new Set(task.messages.map((m) => m.id));

  const messages = task.messages;

  const toBottom = (smooth = false) => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const inner = innerRef.current;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => {
      const h = inner.offsetHeight;
      if (stick.current) toBottom();
      else if (h > lastHeight.current + 1) setUnseen(true);
      lastHeight.current = h;
    });
    ro.observe(inner);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!stickKey) return;
    stick.current = true;
    setUnseen(false);
    toBottom(true);
  }, [stickKey]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = near;
    if (near && unseen) setUnseen(false);
  };

  const last = messages.at(-1);
  const due = upNext(task);
  const busy = status === 'running';
  const canRetry = !busy && !task.archived && me.llmReady;
  const starting = due ? { agent: due, phase: task.phase } : null;

  return (
    <div className="tv-thread">
      <div className="tv-thread-scroll" ref={scrollRef} onScroll={onScroll}>
        <ol className="tv-thread-list" ref={innerRef} aria-label="Conversation">
          {messages.map((m, i) => {
            const prev = messages[i - 1];
            const grouped = !!prev && m.from === 'client' && prev.from === 'client' && prev.kind === 'chat' && m.kind === 'chat' && m.at - prev.at < GROUP_MS;
            return (
              <MessageRow
                key={m.id}
                message={m}
                tools={activity[m.id]}
                animate={!initialIds.current!.has(m.id) && !streamed.has(m.id)}
                grouped={grouped}
                isLast={m === last}
                canRetry={canRetry}
                onRetry={retry}
                onOpenPanel={onOpenPanel}
              />
            );
          })}

          {status === 'running' && <LiveBubble store={live} fallback={starting} />}

          {offline && (
            <Notice who="system" tone="warn">
              <p><strong>Can't reach the server.</strong> The team keeps working without this window; this view catches up when the connection is back.</p>
            </Notice>
          )}

          {!me.llmReady && due && !task.archived && (
            <Notice who="system" tone="warn">
              <p><strong>The agents can't run yet.</strong> The server has no Claude credentials configured, so {AGENTS[due].name} can't pick this up.</p>
              <p className="hint">Your messages are saved; the team continues once the server is set up.</p>
            </Notice>
          )}

          {me.llmReady && paused && !task.archived && (due || busy) && (
            <Notice who={due ?? 'system'} tone="info">
              <p>
                <strong>Paused.</strong>{' '}
                {busy ? 'The step already running finishes first; nothing new starts after it.' : due ? `${AGENTS[due].name} is up next and starts when you resume.` : ''}
              </p>
              <div className="tv-notice-actions"><button type="button" className="btn small" onClick={() => void setPaused(false)}>Resume</button></div>
            </Notice>
          )}
        </ol>
      </div>
      {unseen && (
        <button type="button" className="tv-unseen pop-in" onClick={() => { stick.current = true; setUnseen(false); toBottom(true); }}>
          New activity <span aria-hidden="true">↓</span>
        </button>
      )}
    </div>
  );
}
