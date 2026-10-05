/**
 * The New request composer: the client describes what they need in their own
 * words and Atlas picks it up. The draft lives in the shell (and the session),
 * so closing the modal by accident loses nothing. With several stores the
 * client picks which one it is for (the last one used is remembered).
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { Store } from '../../agency/types';
import { createTask } from '../state';
import { navigate, paths } from '../router';
import { openSettings } from '../views/SettingsView';
import { ENV_LABEL } from '../ui/format';
import { Modal } from '../ui/Modal';
import { Icon } from '../ui/Icon';
import { toast } from '../ui/toast';

export const EXAMPLES = [
  {
    label: 'Size guide drawer',
    text: 'Add a "Size guide" link under the size selector on product pages that opens a drawer with a size chart. Different charts for tops and bottoms, and it should work on mobile.',
  },
  {
    label: 'Free shipping bar',
    text: 'Show a progress bar in the cart drawer: "You\'re $X away from free shipping" that fills up as items are added, and turns into "You\'ve got free shipping!" over $75.',
  },
  {
    label: 'Back in stock form',
    text: 'When a variant is sold out, replace the Add to cart button with a "Notify me when it\'s back" email form on the product page, and tag the customer so we can email them.',
  },
] as const;

const DRAFT_KEY = 'agentify:new-request-draft';

export function loadDraft(): string {
  try { return sessionStorage.getItem(DRAFT_KEY) ?? ''; } catch { return ''; }
}

export function saveDraft(text: string): void {
  try {
    if (text) sessionStorage.setItem(DRAFT_KEY, text);
    else sessionStorage.removeItem(DRAFT_KEY);
  } catch { /* storage unavailable: the in-memory draft still works */ }
}

const STORE_KEY = 'agentify:last-store';
const readLastStore = () => { try { return localStorage.getItem(STORE_KEY); } catch { return null; } };
const rememberStore = (id: string) => { try { localStorage.setItem(STORE_KEY, id); } catch { /* not remembered */ } };

interface Props {
  open: boolean;
  onClose: () => void;
  draft: string;
  onDraft: (text: string) => void;
  llmReady: boolean;
  stores: Store[];
}

export function NewRequest({ open, onClose, draft, onDraft, llmReady, stores }: Props) {
  const [storeChoice, setStoreChoice] = useState<string | null>(readLastStore);
  // The remembered store if it still exists, else the first.
  const store = stores.find((s) => s.id === storeChoice) ?? stores[0] ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const empty = draft.trim().length === 0;

  useEffect(() => { if (open) setError(null); }, [open]);

  function fill(text: string) {
    onDraft(text);
    requestAnimationFrame(() => {
      const el = area.current;
      if (el) { el.focus(); el.setSelectionRange(text.length, text.length); }
    });
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (empty || busy) return;
    setBusy(true);
    setError(null);
    try {
      const task = await createTask({ message: draft.trim(), storeId: store?.id ?? null });
      if (store) rememberStore(store.id);
      onDraft('');
      onClose();
      navigate(paths.task(task.id));
      toast(`Request #${task.number} opened. Atlas is on it.`, 'ok');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the request.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy={`${id}-title`} className="newreq">
      <form className="newreq-form" onSubmit={submit}>
        <div className="newreq-head">
          <div>
            <h2 id={`${id}-title`} className="newreq-title">New request</h2>
            <p className="newreq-sub">Describe it the way you'd tell a developer. Atlas will ask about anything unclear.</p>
          </div>
          <button type="button" className="btn ghost icon small" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
        </div>

        <label htmlFor={`${id}-text`} className="sr-only">What do you need?</label>
        <textarea
          id={`${id}-text`} ref={area} data-autofocus
          className="textarea newreq-text" rows={6} maxLength={8000}
          placeholder="e.g. Add a sticky add-to-cart bar on mobile product pages…"
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(); }}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-help`}
          disabled={busy}
        />

        <div className="newreq-examples" aria-label="Examples">
          <span className="newreq-examples-label">Try</span>
          {EXAMPLES.map((ex) => (
            <button key={ex.label} type="button" className="newreq-chip" onClick={() => fill(ex.text)} disabled={busy}>
              <Icon name="spark" size={13} /> {ex.label}
            </button>
          ))}
        </div>

        {stores.length > 1 && (
          <div className="newreq-store">
            <label htmlFor={`${id}-store`}>For</label>
            <select id={`${id}-store`} className="select newreq-select" value={store?.id ?? ''} onChange={(e) => setStoreChoice(e.target.value)} disabled={busy}>
              {stores.map((s) => <option key={s.id} value={s.id}>{s.label} · {ENV_LABEL[s.env]}</option>)}
            </select>
          </div>
        )}
        {(!store || (!store.shopify && !store.repo)) && (
          <p className="hint newreq-nostore">
            <Icon name="info" size={13} />
            <span>
              {store ? `${store.label} isn’t connected yet, so` : 'No store is set up, so'} the team will work from stated assumptions about your theme
              and deliver files with install notes.{' '}
              <button type="button" className="link-btn" onClick={() => { onClose(); openSettings('stores'); }}>
                {store ? 'Connect it in Settings' : 'Add a store in Settings'}
              </button>
            </span>
          </p>
        )}

        {error && <div className="banner fade-in" data-tone="danger" role="alert">{error}</div>}
        {!llmReady && !error && (
          <div className="banner" data-tone="warn">You can open the request now; the agents will start once the server has Claude credentials.</div>
        )}

        <div className="newreq-foot">
          <span id={`${id}-help`} className="hint newreq-hint"><kbd>⌘</kbd><kbd>Enter</kbd> to send</span>
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn primary" disabled={empty || busy}>
            {busy ? <span className="spinner" aria-hidden="true" /> : <span className="avatar small" data-who="atlas" aria-hidden="true">A</span>}
            {busy ? 'Opening…' : 'Send to Atlas'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
