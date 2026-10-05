/**
 * Accepting an invitation (/dashboard/join/:token). Shown whether or not
 * someone is signed in: the invited person usually is not, but an existing
 * account belongs to another workspace and has to sign out first.
 */
import { useEffect, useId, useState, type FormEvent } from 'react';
import type { Me } from '../../agency/types';
import { api, ApiFailure } from '../api';
import { navigate, paths } from '../router';
import { enterSession, signOut } from '../state';
import { Logo } from '../ui/Logo';
import './auth.css';
import './join.css';

type Info = { email: string; workspaceName: string; invitedBy: string };
type Load = { status: 'loading' } | { status: 'error'; code: string; message: string } | { status: 'ready'; info: Info };

export function JoinScreen({ token, me }: { token: string; me: Me | null }) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    api.inviteInfo(token).then(
      (info) => live && setLoad({ status: 'ready', info }),
      (err: unknown) => live && setLoad({
        status: 'error',
        code: err instanceof ApiFailure ? err.code : 'error',
        message: err instanceof Error ? err.message : 'Something went wrong.',
      }),
    );
    return () => { live = false; };
  }, [token]);

  return (
    <div className="boot join">
      <div className="join-card card pop-in">
        <Logo />
        {load.status === 'loading' && (
          <div className="join-loading" role="status" aria-label="Loading the invitation"><span className="spinner" aria-hidden="true" /></div>
        )}
        {load.status === 'error' && <Unusable code={load.code} message={load.message} signedIn={!!me} />}
        {load.status === 'ready' && (me ? <SignedIn me={me} info={load.info} /> : <JoinForm token={token} info={load.info} />)}
      </div>
    </div>
  );
}

function Unusable({ code, message, signedIn }: { code: string; message: string; signedIn: boolean }) {
  const title = code === 'invite_expired' ? 'This invitation has expired'
    : code === 'invalid_invite' ? 'This invitation can’t be used' : 'Couldn’t open the invitation';
  return (
    <>
      <h1 className="auth-title">{title}</h1>
      <p className="auth-sub">{message}</p>
      <div className="join-actions">
        <a className="btn" href={paths.list()} onClick={(e) => { e.preventDefault(); navigate(paths.list()); }}>{signedIn ? 'Go to your workspace' : 'Go to sign in'}</a>
        {code !== 'invite_expired' && code !== 'invalid_invite' && (
          <button type="button" className="btn ghost" onClick={() => window.location.reload()}>Try again</button>
        )}
      </div>
    </>
  );
}

function SignedIn({ me, info }: { me: Me; info: Info }) {
  const [busy, setBusy] = useState(false);
  const here = me.workspace.name === info.workspaceName && me.user.email === info.email;
  return (
    <>
      <h1 className="auth-title">{info.invitedBy} invited you to {info.workspaceName}</h1>
      <p className="auth-sub">
        {here
          ? 'You already belong to this workspace.'
          : <>You’re signed in as <strong>{me.user.email}</strong> in <strong>{me.workspace.name}</strong>. An account belongs to one workspace, so sign out first, then accept the invitation as <strong>{info.email}</strong>.</>}
      </p>
      <div className="join-actions">
        {!here && (
          <button type="button" className="btn primary" disabled={busy} onClick={async () => { setBusy(true); await signOut(); setBusy(false); }}>
            {busy && <span className="spinner" aria-hidden="true" />} Sign out and continue
          </button>
        )}
        <button type="button" className="btn ghost" onClick={() => navigate(paths.list())}>Back to {me.workspace.name}</button>
      </div>
    </>
  );
}

function JoinForm({ token, info }: { token: string; info: Info }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field?: 'name' | 'password'; message: string } | null>(null);
  const id = useId();

  const nameError = !name.trim() ? 'Enter your name.' : null;
  const passwordError = !password ? 'Choose a password.' : password.length < 8 ? 'Use at least 8 characters.' : null;
  const shownName = (tried && nameError) || (error?.field === 'name' ? error.message : null);
  const shownPassword = (tried && passwordError) || (error?.field === 'password' ? error.message : null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (nameError || passwordError || busy) {
      document.getElementById(`${id}-${nameError ? 'name' : 'password'}`)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.acceptInvite({ token, name: name.trim(), password });
      await enterSession();
      navigate(paths.list(), { replace: true });
    } catch (err) {
      const code = err instanceof ApiFailure ? err.code : '';
      const message = err instanceof Error ? err.message : 'Something went wrong.';
      setError({ field: code === 'invalid_name' ? 'name' : code === 'weak_password' ? 'password' : undefined, message });
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="auth-title">{info.invitedBy} invited you to {info.workspaceName}</h1>
      <p className="auth-sub">Create your account to see the workspace’s requests and talk with the team.</p>
      <form className="auth-form join-form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={`${id}-email`}>Email</label>
          <input id={`${id}-email`} className="input" value={info.email} readOnly aria-describedby={`${id}-email-hint`} />
          <span id={`${id}-email-hint`} className="hint">The invitation is for this address.</span>
        </div>
        <div className="field">
          <label htmlFor={`${id}-name`}>Your name</label>
          <input id={`${id}-name`} className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" autoFocus
            maxLength={80} disabled={busy} aria-invalid={shownName ? true : undefined} aria-describedby={shownName ? `${id}-name-err` : undefined} />
          {shownName && <span id={`${id}-name-err`} className="error-text">{shownName}</span>}
        </div>
        <div className="field">
          <label htmlFor={`${id}-password`}>Password</label>
          <input id={`${id}-password`} className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password" placeholder="At least 8 characters" disabled={busy}
            aria-invalid={shownPassword ? true : undefined} aria-describedby={shownPassword ? `${id}-pw-err` : undefined} />
          {shownPassword && <span id={`${id}-pw-err`} className="error-text">{shownPassword}</span>}
        </div>
        <div className="auth-form-error" role="alert" aria-live="assertive">
          {error && !error.field && <div className="banner fade-in" data-tone="danger">{error.message}</div>}
        </div>
        <button type="submit" className="btn primary large auth-submit" disabled={busy}>
          {busy && <span className="spinner" aria-hidden="true" />} {busy ? 'Joining…' : `Join ${info.workspaceName}`}
        </button>
      </form>
    </>
  );
}
