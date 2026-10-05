/**
 * Sign in / create account. One card for both modes: the sign-up-only fields
 * slide open above the rest, so switching modes never jumps the layout.
 * Validates inline and shows server errors on the field they belong to.
 */
import { useId, useRef, useState, type FormEvent } from 'react';
import { api, ApiFailure } from '../api';
import { enterSession } from '../state';
import { Logo } from '../ui/Logo';
import './auth.css';

type Mode = 'signin' | 'signup';
type Field = 'email' | 'password' | 'name' | 'workspaceName';
type Errors = Partial<Record<Field | 'form', string>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Which field a server error code belongs to. */
const CODE_FIELD: Record<string, Field> = {
  invalid_email: 'email', email_taken: 'email', weak_password: 'password', invalid_name: 'name',
};

function validate(mode: Mode, v: Record<Field, string>): Errors {
  const e: Errors = {};
  if (!v.email.trim()) e.email = 'Enter your email.';
  else if (!EMAIL.test(v.email.trim())) e.email = 'That does not look like an email address.';
  if (!v.password) e.password = 'Enter your password.';
  else if (mode === 'signup' && v.password.length < 8) e.password = 'Use at least 8 characters.';
  if (mode === 'signup' && !v.name.trim()) e.name = 'Enter your name.';
  return e;
}

export function AuthScreen() {
  const [mode, setMode] = useState<Mode>('signin');
  const [values, setValues] = useState<Record<Field, string>>({ email: '', password: '', name: '', workspaceName: '' });
  const [errors, setErrors] = useState<Errors>({});
  /** Show field errors only after a submit attempt, then live. */
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const id = useId();
  const signup = mode === 'signup';

  function update(field: Field, value: string) {
    const next = { ...values, [field]: value };
    setValues(next);
    if (tried) setErrors(validate(mode, next));
  }

  function switchMode(next: Mode) {
    setMode(next);
    setErrors(tried ? validate(next, values) : {});
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    const found = validate(mode, values);
    setErrors(found);
    if (Object.keys(found).length) {
      const first = (['name', 'workspaceName', 'email', 'password'] as Field[]).find((f) => found[f]);
      form.current?.querySelector<HTMLInputElement>(`[name="${first}"]`)?.focus();
      return;
    }
    setBusy(true);
    try {
      const email = values.email.trim();
      if (signup) await api.signup({ email, password: values.password, name: values.name.trim(), workspaceName: values.workspaceName.trim() });
      else await api.login({ email, password: values.password });
      await enterSession();
    } catch (err) {
      const field = err instanceof ApiFailure ? CODE_FIELD[err.code] : undefined;
      const message = err instanceof Error ? err.message : 'Something went wrong.';
      setErrors(field ? { [field]: message } : { form: message });
      setBusy(false);
    }
  }

  const input = (field: Field, label: string, props: React.InputHTMLAttributes<HTMLInputElement>, hint?: string) => (
    <div className="field">
      <label htmlFor={`${id}-${field}`}>{label}</label>
      <input
        id={`${id}-${field}`} name={field} className="input" value={values[field]}
        onChange={(e) => update(field, e.target.value)}
        aria-invalid={errors[field] ? true : undefined}
        aria-describedby={errors[field] || hint ? `${id}-${field}-msg` : undefined}
        disabled={busy}
        {...props}
      />
      {errors[field] ? <span id={`${id}-${field}-msg`} className="error-text">{errors[field]}</span>
        : hint ? <span id={`${id}-${field}-msg`} className="hint">{hint}</span> : null}
    </div>
  );

  return (
    <div className="auth">
      <div className="auth-side" aria-hidden="true">
        <div className="auth-side-inner">
          <p className="auth-quote">Describe what your store needs. Six agents take it from brief to a preview theme.</p>
          <ol className="auth-flow">
            {['Atlas writes the brief', 'Forge checks it against Shopify', 'Muse designs it', 'Volt builds it', 'Sieve tests it', 'You approve, Relay ships it'].map((s, i) => (
              <li key={s} style={{ animationDelay: `${120 + i * 70}ms` }} className="fade-in"><span>{i + 1}</span>{s}</li>
            ))}
          </ol>
        </div>
      </div>
      <main className="auth-main">
        <div className="auth-card pop-in">
          <Logo />
          <h1 className="auth-title">{signup ? 'Create your workspace' : 'Welcome back'}</h1>
          <p className="auth-sub">{signup ? 'One workspace per store. You can connect Shopify after.' : 'Sign in to see your requests and the team.'}</p>

          <div className="auth-tabs" role="tablist" aria-label="Account">
            <button type="button" role="tab" aria-selected={!signup} className="auth-tab" onClick={() => switchMode('signin')}>Sign in</button>
            <button type="button" role="tab" aria-selected={signup} className="auth-tab" onClick={() => switchMode('signup')}>Create account</button>
            <span className="auth-tab-ink" data-mode={mode} aria-hidden="true" />
          </div>

          <form ref={form} className="auth-form" onSubmit={submit} noValidate>
            <div className="auth-extra" data-open={signup} inert={!signup}>
              <div className="auth-extra-inner">
                {input('name', 'Your name', { autoComplete: 'name', placeholder: 'Ada Lovelace' })}
                {input('workspaceName', 'Store or workspace name', { autoComplete: 'organization', placeholder: 'Northwind Goods' }, 'Optional. You can change it later.')}
              </div>
            </div>
            {input('email', 'Email', { type: 'email', autoComplete: 'email', placeholder: 'you@store.com', autoFocus: true })}
            {input('password', 'Password', {
              type: 'password', autoComplete: signup ? 'new-password' : 'current-password',
              placeholder: signup ? 'At least 8 characters' : '••••••••',
            })}
            <div className="auth-form-error" role="alert" aria-live="assertive">
              {errors.form && <div className="banner fade-in" data-tone="danger">{errors.form}</div>}
            </div>
            <button type="submit" className="btn primary large auth-submit" disabled={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {busy ? (signup ? 'Creating workspace…' : 'Signing in…') : signup ? 'Create workspace' : 'Sign in'}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}

/** Shown while the session check runs, or when the server is unreachable. */
export function BootScreen({ offline, onRetry }: { offline?: string; onRetry?: () => void }) {
  const [retrying, setRetrying] = useState(false);
  return (
    <div className="boot">
      {offline ? (
        <div className="boot-card card pop-in" role="alert">
          <Logo />
          <h1 className="auth-title">Can't reach Agentify</h1>
          <p className="auth-sub">{offline} Your work is safe on the server; this is a connection problem, not a sign-out.</p>
          <button
            type="button" className="btn primary" disabled={retrying}
            onClick={async () => { setRetrying(true); await onRetry?.(); setRetrying(false); }}
          >
            {retrying && <span className="spinner" aria-hidden="true" />} Try again
          </button>
        </div>
      ) : (
        <div className="boot-loading" role="status" aria-label="Loading">
          <Logo />
          <span className="spinner" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}
