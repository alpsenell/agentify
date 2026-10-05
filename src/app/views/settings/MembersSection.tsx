/**
 * Settings → Members: who is in the workspace, pending invitations, the
 * invite form (owner only) and the current user's email preference.
 * Invitation links are only known right after creating one (the server
 * keeps a hash), so "Copy link" exists for invitations made in this visit.
 */
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import type { Invite, Me, User } from '../../../agency/types';
import { PLANS } from '../../../agency/plans';
import { api, ApiFailure, type Members } from '../../api';
import { refreshMe } from '../../state';
import { Icon } from '../../ui/Icon';
import { toast } from '../../ui/toast';
import './members.css';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY = 86_400_000;
const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.');
const shortDate = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function expiresIn(at: number): string {
  const days = Math.ceil((at - Date.now()) / DAY);
  return days <= 1 ? 'Expires within a day' : `Expires in ${days} days`;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export default function MembersSection({ me }: { me: Me }) {
  const [data, setData] = useState<Members | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Join links for invitations created in this visit, by invite id. */
  const [links, setLinks] = useState<Record<string, string>>({});
  const id = useId();
  const owner = me.user.role === 'owner';
  const limit = PLANS[me.workspace.plan.tier].memberLimit;

  const load = useCallback(async () => {
    try {
      setData(await api.members());
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const seats = data ? data.members.length + data.invites.length : null;
  const full = seats !== null && seats >= limit;

  return (
    <section className="set-section card fade-in" aria-labelledby={`${id}-t`}>
      <div className="set-intro">
        <h2 id={`${id}-t`} className="section-title">Members</h2>
        <p className="section-sub">Everyone here sees every request and can talk with the team and approve work. Only the owner manages members, the plan and connections.</p>
        {seats !== null && (
          <p className="mem-seats" data-full={full || undefined}>
            <strong>{seats} of {limit}</strong> seats used{data!.invites.length > 0 && <span className="hint"> · pending invitations hold a seat</span>}
          </p>
        )}
      </div>
      <div className="set-body">
        {loadError && (
          <div className="banner" data-tone="warn" role="alert">
            <span>Couldn’t load members: {loadError}</span>
            <button type="button" className="btn small" onClick={() => void load()}>Retry</button>
          </div>
        )}
        {!data && !loadError && <div className="mem-skeleton"><div className="skeleton" /><div className="skeleton" /></div>}

        {data && (
          <ul className="mem-list" aria-label="Members">
            {data.members.map((u) => (
              <MemberRow key={u.id} user={u} me={me} onRemoved={() => setData((d) => d && { ...d, members: d.members.filter((m) => m.id !== u.id) })} />
            ))}
          </ul>
        )}

        {data && data.invites.length > 0 && (
          <div className="mem-group">
            <h3 className="mem-group-title">Pending invitations</h3>
            <ul className="mem-list" aria-label="Pending invitations">
              {data.invites.map((inv) => (
                <InviteRow key={inv.id} invite={inv} link={links[inv.id]} owner={owner}
                  onRevoked={() => setData((d) => d && { ...d, invites: d.invites.filter((i) => i.id !== inv.id) })} />
              ))}
            </ul>
          </div>
        )}

        {owner && data && (
          <InviteForm
            full={full} limit={limit} planName={PLANS[me.workspace.plan.tier].name} emailOn={me.capabilities.email}
            onInvited={(invite, link) => {
              setLinks((l) => ({ ...l, [invite.id]: link }));
              setData((d) => d && { ...d, invites: [...d.invites, invite] });
            }}
          />
        )}

        <div className="divider" />
        <NotifyToggle me={me} />
      </div>
    </section>
  );
}

function MemberRow({ user, me, onRemoved }: { user: User; me: Me; onRemoved: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const self = user.id === me.user.id;
  const removable = me.user.role === 'owner' && !self && user.role !== 'owner';

  async function remove() {
    setBusy(true);
    try {
      await api.removeMember(user.id);
      toast(`${user.name} was removed from the workspace.`, 'ok');
      onRemoved();
    } catch (err) {
      toast(errorText(err), 'danger');
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <li className="mem-row" data-confirming={confirming || undefined}>
      <span className="avatar" data-who="client" aria-hidden="true">{user.name.trim()[0]?.toUpperCase() ?? '?'}</span>
      <div className="mem-who">
        <span className="mem-name">{user.name}{self && <span className="hint"> (you)</span>}</span>
        <span className="hint mem-email">{user.email}</span>
      </div>
      {confirming ? (
        <div className="mem-confirm fade-in" role="group" aria-label={`Remove ${user.name}?`}>
          <span className="mem-confirm-text">Remove {user.name}? Their account is deleted; their messages stay.</span>
          <button type="button" className="btn small ghost" onClick={() => setConfirming(false)} disabled={busy} autoFocus>Cancel</button>
          <button type="button" className="btn small danger" onClick={() => void remove()} disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />} Remove
          </button>
        </div>
      ) : (
        <>
          <span className="tag" data-tone={user.role === 'owner' ? 'accent' : undefined}>{user.role === 'owner' ? 'Owner' : 'Member'}</span>
          <span className="hint mem-date" title={`Joined ${shortDate(user.createdAt)}`}>Joined {shortDate(user.createdAt)}</span>
          {removable
            ? <button type="button" className="btn small ghost mem-action" onClick={() => setConfirming(true)} aria-label={`Remove ${user.name}`}>Remove</button>
            : <span className="mem-action" aria-hidden="true" />}
        </>
      )}
    </li>
  );
}

function InviteRow({ invite, link, owner, onRevoked }: { invite: Invite; link?: string; owner: boolean; onRevoked: () => void }) {
  const [busy, setBusy] = useState(false);

  async function revoke() {
    setBusy(true);
    try {
      await api.revokeInvite(invite.id);
      toast(`Invitation to ${invite.email} revoked. The link no longer works.`, 'ok');
      onRevoked();
    } catch (err) {
      toast(errorText(err), 'danger');
      setBusy(false);
    }
  }

  return (
    <li className="mem-row">
      <span className="avatar mem-pending" aria-hidden="true"><Icon name="arrow" size={12} /></span>
      <div className="mem-who">
        <span className="mem-name">{invite.email}</span>
        <span className="hint">Invited by {invite.invitedBy} · {expiresIn(invite.expiresAt)}</span>
      </div>
      {owner && link && (
        <button type="button" className="btn small" onClick={async () => toast((await copy(link)) ? 'Link copied.' : 'Couldn’t copy; select the link and copy it.', 'ok')}>
          Copy link
        </button>
      )}
      {owner && (
        <button type="button" className="btn small ghost mem-action" onClick={() => void revoke()} disabled={busy} aria-label={`Revoke the invitation to ${invite.email}`}>
          {busy && <span className="spinner" aria-hidden="true" />} Revoke
        </button>
      )}
    </li>
  );
}

function InviteForm({ full, limit, planName, emailOn, onInvited }: {
  full: boolean; limit: number; planName: string; emailOn: boolean; onInvited: (invite: Invite, link: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ email: string; link: string } | null>(null);
  const id = useId();
  const clean = email.trim();
  const invalid = !clean ? 'Enter an email address.' : !EMAIL.test(clean) ? 'That doesn’t look like an email address.' : null;
  const shown = (tried && invalid) || error;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (invalid || busy || full) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.invite(clean);
      onInvited(res.invite, res.link);
      setEmail('');
      setTried(false);
      if (res.emailed) {
        setMade(null);
        toast(`Invitation sent to ${res.invite.email}.`, 'ok');
      } else {
        setMade({ email: res.invite.email, link: res.link });
      }
    } catch (err) {
      setError(errorText(err));
      if (err instanceof ApiFailure && err.code === 'plan_limit') setTried(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mem-group">
      <form className="mem-invite" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={`${id}-email`}>Invite someone</label>
          <div className="mem-invite-row">
            <input id={`${id}-email`} className="input" type="email" autoComplete="off" placeholder="name@store.com" value={email}
              onChange={(e) => { setEmail(e.target.value); setError(null); }} disabled={busy || full}
              aria-invalid={shown ? true : undefined} aria-describedby={`${id}-msg`} />
            <button type="submit" className="btn primary" disabled={busy || full}>
              {busy && <span className="spinner" aria-hidden="true" />} {busy ? 'Inviting…' : 'Send invite'}
            </button>
          </div>
          <span id={`${id}-msg`} className={shown ? 'error-text' : 'hint'}>
            {shown || (full
              ? <>All {limit} seats on {planName} are taken. Revoke an invitation, remove a member, or <a href="#billing">upgrade the plan</a>.</>
              : emailOn ? 'They get an email with a link to join. The link works once and expires in 7 days.'
                : 'Email isn’t set up on this server, so you’ll get a link to send them yourself. It works once and expires in 7 days.')}
          </span>
        </div>
      </form>
      {made && (
        <div className="banner mem-link fade-in" data-tone="ok" role="status">
          <div className="mem-link-body">
            <span>Invitation created for <strong>{made.email}</strong>. Send them this link:</span>
            <input className="input mono" readOnly value={made.link} onFocus={(e) => e.currentTarget.select()} aria-label="Join link" />
          </div>
          <div className="mem-link-actions">
            <button type="button" className="btn small primary" onClick={async () => toast((await copy(made.link)) ? 'Link copied.' : 'Couldn’t copy; select the link and copy it.', 'ok')}>Copy link</button>
            <button type="button" className="btn small ghost" onClick={() => setMade(null)} aria-label="Dismiss">Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

function NotifyToggle({ me }: { me: Me }) {
  const [on, setOn] = useState(me.user.notify);
  const [busy, setBusy] = useState(false);
  const id = useId();
  useEffect(() => setOn(me.user.notify), [me.user.notify]);

  async function change(next: boolean) {
    setOn(next);
    setBusy(true);
    try {
      await api.updateMe({ notify: next });
      await refreshMe();
    } catch (err) {
      setOn(!next);
      toast(`Couldn’t save that: ${errorText(err)}`, 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mem-notify">
      <label className="switch" htmlFor={`${id}-n`}>
        <input id={`${id}-n`} type="checkbox" role="switch" checked={on} disabled={busy} onChange={(e) => void change(e.target.checked)}
          aria-describedby={`${id}-h`} />
        <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
        <span className="switch-label">Email me when a request needs me</span>
      </label>
      <span id={`${id}-h`} className="hint">
        {me.capabilities.email
          ? <>When Atlas has a question or a build is waiting for approval, we email {me.user.email}. Once per question, not per step.</>
          : <>Email isn’t set up on this server yet, so nothing is sent. Your choice is saved and applies once it is.</>}
      </span>
    </div>
  );
}
