/**
 * The approval bar at the gate: what was built, Sieve's verdict and the
 * automated checks (failures and lint errors impossible to miss), and
 * Approve / Return with a required reason.
 */
import { useEffect, useRef, useState } from 'react';
import type { Task } from '../../agency/types';
import { AutoChecks, checkCounts, type PanelId } from './panels';

interface GateProps {
  task: Task;
  onDecide: (decision: 'approve' | 'return', note: string) => Promise<string | null>;
  onOpenPanel: (panel: PanelId) => void;
}

export function GateBar({ task, onDecide, onOpenPanel }: GateProps) {
  const [mode, setMode] = useState<'approve' | 'return' | null>(null);
  const [note, setNote] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const approveRef = useRef<HTMLButtonElement>(null);
  const returnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (mode) noteRef.current?.focus(); }, [mode]);

  const build = task.build;
  const review = task.review;
  const failing = review?.checks.filter((c) => !c.pass) ?? [];
  const { errors, warnings } = checkCounts(build?.checks ?? null);

  const open = (next: 'approve' | 'return') => {
    setMode(next);
    setInvalid(false);
    setError(null);
  };
  const cancel = () => {
    const back = mode === 'approve' ? approveRef : returnRef;
    setMode(null);
    setInvalid(false);
    requestAnimationFrame(() => back.current?.focus());
  };
  const submit = async () => {
    if (!mode) return;
    if (mode === 'return' && !note.trim()) {
      setInvalid(true);
      noteRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const err = await onDecide(mode, note.trim());
    setBusy(false);
    if (err) setError(err);
    else { setMode(null); setNote(''); }
  };

  return (
    <section className="tv-gate pop-in" aria-labelledby="tv-gate-title" data-verdict={review?.verdict}>
      <div className="tv-gate-head">
        <div>
          <h3 id="tv-gate-title">Ready for your approval</h3>
          <p className="tv-gate-sum">
            {build ? (
              <>
                {build.files.length} file{build.files.length === 1 ? '' : 's'} · round {build.round}
                {' · '}
                <button type="button" className="tv-link" onClick={() => onOpenPanel('files')}>View files</button>
              </>
            ) : 'No build attached.'}
          </p>
        </div>
        <span className="tv-gate-tags">
        {build && (
          <button type="button" className="tag tv-gate-verdict" onClick={() => onOpenPanel('review')}
            data-tone={build.checks === null ? 'warn' : errors ? 'danger' : warnings ? 'warn' : 'ok'}>
            {build.checks === null ? 'Checks could not run' : errors ? `Lint · ${errors} error${errors === 1 ? '' : 's'}` : warnings ? `Lint · ${warnings} warning${warnings === 1 ? '' : 's'}` : 'Lint clean'}
          </button>
        )}
        {review && (
          <button type="button" className="tag tv-gate-verdict" data-tone={review.verdict === 'pass' ? 'ok' : 'danger'} onClick={() => onOpenPanel('review')}>
            {review.verdict === 'pass' ? `QA passed · ${review.checks.length}/${review.checks.length}` : `QA failed · ${failing.length} check${failing.length === 1 ? '' : 's'}`}
          </button>
        )}
        </span>
      </div>
      {build?.summary && <p className="tv-gate-text">{build.summary}</p>}
      {review?.verdict === 'fail' && (
        <div className="tv-gate-fail" role="alert">
          <p><strong>Sieve did not pass this build.</strong> It reached you after the maximum rework rounds. Failing checks:</p>
          <ul>{failing.map((c, i) => <li key={i}><strong>{c.criterion}</strong>{c.note ? ` — ${c.note}` : ''}</li>)}</ul>
        </div>
      )}

      {errors > 0 && (
        <div className="tv-gate-fail" role="alert">
          <p><strong>The automated checks found {errors} error{errors === 1 ? '' : 's'} in this build.</strong> Approving ships {errors === 1 ? 'it' : 'them'} as they are; returning sends the build back to Volt.</p>
          <AutoChecks checks={build!.checks} compact />
        </div>
      )}

      {mode ? (
        <div className="tv-gate-form fade-in">
          <label className="label" htmlFor="tv-gate-note">
            {mode === 'approve' ? 'Note for the team (optional)' : 'What should change?'}
          </label>
          <textarea
            id="tv-gate-note"
            ref={noteRef}
            className="textarea"
            rows={3}
            value={note}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? 'tv-gate-err' : undefined}
            placeholder={mode === 'approve' ? 'Anything Relay should know before shipping…' : 'Tell Volt what to fix or change…'}
            onChange={(e) => { setNote(e.target.value); if (invalid && e.target.value.trim()) setInvalid(false); }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); }
            }}
          />
          {mode === 'approve' && errors > 0 && <p className="error-text">You are approving a build with {errors} lint error{errors === 1 ? '' : 's'}.</p>}
          {invalid && <p id="tv-gate-err" className="error-text">Add a reason so the team knows what to change.</p>}
          {error && <p className="error-text" role="alert">{error}</p>}
          <div className="tv-gate-actions">
            <button type="button" className="btn ghost" onClick={cancel} disabled={busy}>Cancel</button>
            <button type="button" className={mode === 'approve' ? 'btn primary' : 'btn danger'} onClick={submit} disabled={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {mode === 'approve' ? 'Approve and ship' : 'Return to the team'}
            </button>
          </div>
        </div>
      ) : (
        <div className="tv-gate-actions">
          <button ref={returnRef} type="button" className="btn" onClick={() => open('return')}>Return with changes</button>
          <button ref={approveRef} type="button" className="btn primary" onClick={() => open('approve')}>Approve</button>
        </div>
      )}
    </section>
  );
}
