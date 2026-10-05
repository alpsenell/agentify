/**
 * Settings (/dashboard/settings#<section>): a left sub-nav (tabs on small
 * screens) over Workspace · Stores · GitHub · Plan & usage · Members ·
 * Account, one section at a time. GitHub, Plan & usage and Members are
 * teammates' modules, loaded lazily so a missing one shows "coming soon"
 * instead of breaking the build. Non-owners see everything read-only.
 */
import { Component, lazy, Suspense, useEffect, useId, useState, type ComponentType, type FormEvent, type ReactNode } from 'react';
import type { Me } from '../../agency/types';
import { navigate, paths } from '../router';
import { saveMe, saveWorkspace, signOut } from '../state';
import { Icon, type IconName } from '../ui/Icon';
import { toast } from '../ui/toast';
import { StoresSection } from './settings/StoresSection';
import './views.css';

export const SETTINGS_SECTIONS = ['workspace', 'stores', 'github', 'billing', 'members', 'account'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

const SECTION_META: Record<SettingsSection, { label: string; icon: IconName }> = {
  workspace: { label: 'Workspace', icon: 'building' },
  stores: { label: 'Stores', icon: 'store' },
  github: { label: 'GitHub', icon: 'github' },
  billing: { label: 'Plan & usage', icon: 'card' },
  members: { label: 'Members', icon: 'team' },
  account: { label: 'Account', icon: 'user' },
};

const isSection = (v: string): v is SettingsSection => (SETTINGS_SECTIONS as readonly string[]).includes(v);
const sectionFromHash = (): SettingsSection => {
  const h = window.location.hash.replace(/^#/, '');
  // "#shopify" was the single-store page's anchor.
  if (h === 'shopify') return 'stores';
  return isSection(h) ? h : 'workspace';
};

/** Go to one section of Settings from anywhere in the app. */
export function openSettings(section: SettingsSection): void {
  navigate(`${paths.settings()}#${section}`);
  // pushState does not fire hashchange; tell an already-open Settings to switch.
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

/* ── teammates' sections, loaded tolerantly ────────────────────────── */

type SectionProps = { me: Me };
// import.meta.glob resolves to {} for files that do not exist yet, so the build never breaks on them.
const modules = import.meta.glob<{ default: ComponentType<SectionProps> }>([
  './settings/GitHubSection.tsx', './settings/BillingSection.tsx', './settings/MembersSection.tsx',
]);
const lazySection = (file: string, label: string): ComponentType<SectionProps> => {
  const loader = modules[file];
  return loader ? lazy(loader) : () => <ComingSoon label={label} />;
};
const GitHubSection = lazySection('./settings/GitHubSection.tsx', 'GitHub');
const BillingSection = lazySection('./settings/BillingSection.tsx', 'Plan & usage');
const MembersSection = lazySection('./settings/MembersSection.tsx', 'Members');

function ComingSoon({ label }: { label: string }) {
  return (
    <section className="set-section card fade-in">
      <div className="set-intro">
        <h2 className="section-title">{label}</h2>
        <p className="section-sub">Coming soon. This part of Settings is still being built.</p>
      </div>
    </section>
  );
}

/** A crash inside one section stays inside it. */
class SectionBoundary extends Component<{ label: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="set-section card" role="alert">
        <div className="set-intro">
          <h2 className="section-title">{this.props.label}</h2>
          <p className="section-sub">This section could not be shown: {this.state.error.message}</p>
        </div>
        <div className="set-body"><div className="set-actions">
          <button type="button" className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
        </div></div>
      </section>
    );
  }
}

function SectionSkeleton() {
  return (
    <section className="set-section card" aria-busy="true" aria-label="Loading">
      <div className="set-intro"><span className="skeleton" style={{ width: 120, height: 16 }} /><span className="skeleton" style={{ width: '90%', height: 12 }} /></div>
      <div className="set-body"><span className="skeleton" style={{ width: '100%', height: 36 }} /><span className="skeleton" style={{ width: '70%', height: 36 }} /></div>
    </section>
  );
}

/* ── the view ──────────────────────────────────────────────────────── */

export function SettingsView({ me }: { me: Me }) {
  const [section, setSection] = useState<SettingsSection>(sectionFromHash);
  const owner = me.user.role === 'owner';

  useEffect(() => {
    const sync = () => setSection(sectionFromHash());
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => { window.removeEventListener('hashchange', sync); window.removeEventListener('popstate', sync); };
  }, []);

  function pick(e: React.MouseEvent<HTMLAnchorElement>, s: SettingsSection) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${s}`);
    setSection(s);
  }

  const { label } = SECTION_META[section];
  return (
    <div className="view settings-view">
      <nav className="set-nav" aria-label="Settings sections">
        {SETTINGS_SECTIONS.map((s) => (
          <a key={s} href={`#${s}`} className="set-nav-link" aria-current={s === section ? 'page' : undefined} onClick={(e) => pick(e, s)}>
            <Icon name={SECTION_META[s].icon} size={15} />
            <span>{SECTION_META[s].label}</span>
          </a>
        ))}
      </nav>
      <div className="settings" key={section}>
        {!owner && section !== 'account' && (
          <div className="banner" data-tone="info" role="note">
            <Icon name="lock" size={15} />
            <span>Only the workspace owner can change these settings. You can see them here.</span>
          </div>
        )}
        <SectionBoundary label={label}>
          <Suspense fallback={<SectionSkeleton />}>
            {section === 'workspace' && <WorkspaceSection me={me} />}
            {section === 'stores' && <StoresSection me={me} />}
            {section === 'github' && <GitHubSection me={me} />}
            {section === 'billing' && <BillingSection me={me} />}
            {section === 'members' && <MembersSection me={me} />}
            {section === 'account' && <AccountSection me={me} />}
          </Suspense>
        </SectionBoundary>
      </div>
    </div>
  );
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.');

function WorkspaceSection({ me }: { me: Me }) {
  const ws = me.workspace;
  const owner = me.user.role === 'owner';
  const [name, setName] = useState(ws.name);
  const [notes, setNotes] = useState(ws.notes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const dirty = name.trim() !== ws.name || notes !== ws.notes;
  const nameError = name.trim() === '' ? 'Give the workspace a name.' : null;
  const locked = busy || !owner;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!dirty || nameError || locked) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await saveWorkspace({ name: name.trim(), notes });
      setName(saved.name);
      setNotes(saved.notes);
      toast('Workspace saved. The agents will use the new notes from their next step.', 'ok');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="set-section card fade-in" aria-labelledby={`${id}-t`}>
      <div className="set-intro">
        <h2 id={`${id}-t`} className="section-title">Workspace</h2>
        <p className="section-sub">Every agent reads these notes before it works on any of your requests, for every store.</p>
      </div>
      <form className="set-body" onSubmit={save}>
        <div className="field">
          <label htmlFor={`${id}-name`}>Workspace name</label>
          <input id={`${id}-name`} className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)}
            aria-invalid={nameError ? true : undefined} aria-describedby={nameError ? `${id}-name-err` : undefined} disabled={locked} />
          {nameError && <span id={`${id}-name-err`} className="error-text">{nameError}</span>}
        </div>
        <div className="field">
          <label htmlFor={`${id}-notes`}>Notes for the team</label>
          <textarea id={`${id}-notes`} className="textarea set-notes" value={notes} maxLength={4000} onChange={(e) => setNotes(e.target.value)} disabled={locked}
            aria-describedby={`${id}-notes-hint`}
            placeholder={'Brand voice: warm, plain, no exclamation marks.\nTheme: Dawn 15, heavily customised header.\nNever touch the checkout or the cart page layout.\nCustomers: mostly mobile, US and Canada.'} />
          <span id={`${id}-notes-hint`} className="hint">Brand voice, constraints, things to never touch, who your customers are. {notes.length}/4000</span>
        </div>
        {error && <div className="banner fade-in" data-tone="danger" role="alert">{error}</div>}
        {owner && (
          <div className="set-actions">
            {dirty && !busy && <span className="hint fade-in">Unsaved changes</span>}
            {dirty && <button type="button" className="btn ghost" onClick={() => { setName(ws.name); setNotes(ws.notes); setError(null); }} disabled={busy}>Discard</button>}
            <button type="submit" className="btn primary" disabled={!dirty || !!nameError || busy}>
              {busy && <span className="spinner" aria-hidden="true" />} {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </form>
    </section>
  );
}

function AccountSection({ me }: { me: Me }) {
  const [name, setName] = useState(me.user.name);
  const [busy, setBusy] = useState<'name' | 'notify' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const dirty = name.trim() !== me.user.name;
  const nameError = name.trim() === '' ? 'Your name cannot be empty.' : null;

  async function saveName(e: FormEvent) {
    e.preventDefault();
    if (!dirty || nameError || busy) return;
    setBusy('name');
    setError(null);
    try {
      await saveMe({ name: name.trim() });
      toast('Name saved.', 'ok');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function toggleNotify(notify: boolean) {
    setBusy('notify');
    try {
      await saveMe({ notify });
      toast(notify ? 'You’ll get an email when a request needs you.' : 'Emails turned off.', 'ok');
    } catch (err) {
      toast(`Could not save: ${errorText(err)}`, 'danger');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="set-section card fade-in" aria-labelledby={`${id}-t`}>
      <div className="set-intro">
        <h2 id={`${id}-t`} className="section-title">Account</h2>
        <p className="section-sub">You are signed in to {me.workspace.name} as {me.user.role === 'owner' ? 'its owner' : 'a member'}.</p>
      </div>
      <div className="set-body">
        <div className="acct">
          <span className="avatar large" data-who="client" aria-hidden="true">{me.user.name.trim()[0]?.toUpperCase()}</span>
          <div>
            <strong>{me.user.name}</strong>
            <div className="hint">{me.user.email}</div>
          </div>
          <button type="button" className="btn" onClick={() => void signOut()}><Icon name="logout" size={14} /> Sign out</button>
        </div>
        <form className="set-sub" onSubmit={saveName}>
          <div className="field">
            <label htmlFor={`${id}-name`}>Your name</label>
            <input id={`${id}-name`} className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} disabled={busy !== null}
              aria-invalid={nameError ? true : undefined} aria-describedby={nameError ? `${id}-name-err` : undefined} autoComplete="name" />
            {nameError && <span id={`${id}-name-err`} className="error-text">{nameError}</span>}
          </div>
          {error && <div className="banner fade-in" data-tone="danger" role="alert">{error}</div>}
          {dirty && (
            <div className="set-actions fade-in">
              <button type="button" className="btn ghost" onClick={() => { setName(me.user.name); setError(null); }} disabled={busy !== null}>Discard</button>
              <button type="submit" className="btn primary" disabled={!!nameError || busy !== null}>
                {busy === 'name' && <span className="spinner" aria-hidden="true" />} Save
              </button>
            </div>
          )}
        </form>
        <label className="set-toggle set-sub">
          <input type="checkbox" checked={me.user.notify} onChange={(e) => void toggleNotify(e.target.checked)} disabled={busy !== null} />
          <span>
            <strong>Email me when a request needs me</strong>
            <span className="hint">A question from Atlas, or work waiting for your approval.{me.capabilities.email ? '' : ' Emails start once the server has an email provider.'}</span>
          </span>
        </label>
      </div>
    </section>
  );
}
