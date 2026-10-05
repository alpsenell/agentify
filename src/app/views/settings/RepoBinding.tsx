/**
 * A store's theme repository, inside its card in Settings: which repository,
 * base branch and theme folder the agents read and Relay opens pull requests
 * against. Owners connect, change and remove it; members see it read-only.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react';
import type { Me, Store } from '../../../agency/types';
import { api, ApiFailure, type RepoOption } from '../../api';
import { setWorkspace } from '../../state';
import { Icon } from '../../ui/Icon';
import { toast } from '../../ui/toast';
import './github.css';

/** The server lists at most this many; beyond it, typing owner/repo still works. */
const REPO_LIST_CAP = 500;

const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.');

const repoLink = (owner: string, repo: string, branch: string, folder: string) =>
  `https://github.com/${owner}/${repo}/tree/${branch.split('/').map(encodeURIComponent).join('/')}${folder ? `/${folder}` : ''}`;

export default function RepoBinding({ me, store }: { me: Me; store: Store }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const isOwner = me.user.role === 'owner';
  const repo = store.repo;

  if (!me.capabilities.github) return null;

  async function remove() {
    setBusy(true);
    try {
      setWorkspace(await api.unbindRepo(store.id));
      setConfirming(false);
      toast(`${store.label} no longer uses a repository. The agents read the live theme instead, if the store is connected.`, 'ok');
    } catch (err) {
      toast(`Could not remove the repository: ${errorText(err)}`, 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="repo-bind">
      <div className="repo-bind-head">
        <span className="repo-bind-icon" aria-hidden="true"><Icon name="github" size={15} /></span>
        <div className="repo-bind-main">
          <span className="repo-bind-label">Theme repository</span>
          {!me.workspace.github ? (
            <span className="hint">
              {isOwner ? <>Install the GitHub App in the <a href="#github">GitHub section</a> to connect a repository.</> : 'GitHub is not connected.'}
            </span>
          ) : repo ? (
            <span className="repo-bind-value">
              <a href={repoLink(repo.owner, repo.repo, repo.baseBranch, repo.themeRoot)} target="_blank" rel="noopener" className="mono">
                {repo.owner}/{repo.repo} <Icon name="external" size={12} />
              </a>
              <span className="tag mono" title="Pull requests are opened against this branch">{repo.baseBranch}</span>
              <span className="tag mono" title="Theme folder">{repo.themeRoot ? `${repo.themeRoot}/` : 'root'}</span>
            </span>
          ) : (
            <span className="hint">None. The agents read the live theme; approved work is deployed as a preview.</span>
          )}
        </div>
        {isOwner && me.workspace.github && !editing && !confirming && (
          <div className="repo-bind-actions">
            {repo ? (
              <>
                <button type="button" className="btn ghost small" onClick={() => setEditing(true)}>Change</button>
                <button type="button" className="btn ghost small" onClick={() => setConfirming(true)}>Remove</button>
              </>
            ) : (
              <button type="button" className="btn small" onClick={() => setEditing(true)}><Icon name="plus" size={13} /> Connect a repository</button>
            )}
          </div>
        )}
      </div>

      {confirming && repo && (
        <div className="banner gh-confirm pop-in" data-tone="warn" role="alertdialog">
          <Icon name="alert" size={16} />
          <div className="gh-confirm-body">
            <p>Stop using <strong>{repo.owner}/{repo.repo}</strong> for {store.label}? New approvals won't open pull requests there. Existing pull requests stay on GitHub.</p>
            <div className="set-actions">
              <button type="button" className="btn ghost small" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
              <button type="button" className="btn danger small" onClick={() => void remove()} disabled={busy} autoFocus>
                {busy && <span className="spinner" aria-hidden="true" />} Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {editing && <BindForm store={store} onDone={() => setEditing(false)} />}
    </div>
  );
}

/* ── the form ──────────────────────────────────────────────────────── */

type Load<T> = { status: 'loading' } | { status: 'error'; message: string; code: string } | { status: 'ready'; data: T };

function BindForm({ store, onDone }: { store: Store; onDone: () => void }) {
  const id = useId();
  const current = store.repo;
  const [repos, setRepos] = useState<Load<RepoOption[]>>({ status: 'loading' });
  const [picked, setPicked] = useState<{ owner: string; repo: string; defaultBranch?: string } | null>(current ? { owner: current.owner, repo: current.repo } : null);
  const [branches, setBranches] = useState<Load<string[]> | null>(null);
  const [branch, setBranch] = useState(current?.baseBranch ?? '');
  const [folder, setFolder] = useState(current?.themeRoot ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const [branchReloads, setBranchReloads] = useState(0);

  useEffect(() => {
    let live = true;
    setRepos({ status: 'loading' });
    api.listRepos()
      .then((data) => live && setRepos({ status: 'ready', data }))
      .catch((err) => live && setRepos({ status: 'error', message: errorText(err), code: err instanceof ApiFailure ? err.code : '' }));
    return () => { live = false; };
  }, [reloads]);

  // Branches follow the chosen repository; the default branch is first.
  useEffect(() => {
    if (!picked) { setBranches(null); return; }
    let live = true;
    setBranches({ status: 'loading' });
    api.listBranches(picked.owner, picked.repo)
      .then((data) => {
        if (!live) return;
        setBranches({ status: 'ready', data });
        setBranch((b) => (b && data.includes(b) ? b : data[0] ?? ''));
      })
      .catch((err) => live && setBranches({ status: 'error', message: errorText(err), code: err instanceof ApiFailure ? err.code : '' }));
    return () => { live = false; };
  }, [picked?.owner, picked?.repo, branchReloads]);

  async function submit(e: SyntheticEvent) {
    e.preventDefault();
    if (!picked || !branch || busy) return;
    setBusy(true);
    setError(null);
    try {
      const ws = await api.bindRepo(store.id, { owner: picked.owner, repo: picked.repo, baseBranch: branch, themeRoot: folder.trim() });
      setWorkspace(ws);
      const bound = ws.stores.find((s) => s.id === store.id)?.repo;
      toast(`${store.label} now uses ${bound?.owner ?? picked.owner}/${bound?.repo ?? picked.repo}. Approved work will arrive as a pull request against ${branch}.`, 'ok');
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="repo-form pop-in" onSubmit={submit} aria-label={`Connect a repository to ${store.label}`}>
      <div className="field">
        <label id={`${id}-repo-l`} htmlFor={`${id}-repo`}>Repository</label>
        {repos.status === 'loading' && (
          <div className="repo-skel" aria-busy="true" aria-label="Loading repositories">
            <div className="skeleton" /><div className="skeleton" /><div className="skeleton" />
          </div>
        )}
        {repos.status === 'error' && (
          <div className="banner fade-in" data-tone="danger" role="alert">
            <Icon name="alert" size={16} />
            <div className="gh-confirm-body">
              <span>{repos.message}</span>
              <div className="set-actions">
                {repos.code === 'github_installation_missing' && <a className="btn small" href={api.githubInstallUrl()}>Reinstall the app</a>}
                <button type="button" className="btn small" onClick={() => setReloads((n) => n + 1)}>Try again</button>
              </div>
            </div>
          </div>
        )}
        {repos.status === 'ready' && repos.data.length === 0 && (
          <div className="banner fade-in" data-tone="warn">
            <Icon name="info" size={16} />
            <div className="gh-confirm-body">
              <span>The app can't see any repositories. Grant it access to your theme repository on GitHub, then come back.</span>
              <div className="set-actions">
                <a className="btn small" href={api.githubInstallUrl()}>Grant access on GitHub <Icon name="external" size={12} /></a>
                <button type="button" className="btn ghost small" onClick={() => setReloads((n) => n + 1)}>Refresh</button>
              </div>
            </div>
          </div>
        )}
        {repos.status === 'ready' && repos.data.length > 0 && (
          <RepoPicker id={`${id}-repo`} repos={repos.data} value={picked} disabled={busy}
            onPick={(r) => { setPicked(r); setError(null); if (!current || r.owner !== current.owner || r.repo !== current.repo) setBranch(r.defaultBranch ?? ''); }} />
        )}
      </div>

      <div className="repo-form-row">
        <div className="field">
          <label htmlFor={`${id}-branch`}>Base branch</label>
          {branches?.status === 'error' ? (
            <span className="error-text">
              {branches.message}{' '}
              <button type="button" className="btn ghost small" onClick={() => setBranchReloads((n) => n + 1)}>Try again</button>
            </span>
          ) : (
            <select id={`${id}-branch`} className="select" value={branch} onChange={(e) => setBranch(e.target.value)}
              disabled={!picked || busy || branches?.status !== 'ready'} aria-describedby={`${id}-branch-h`}>
              {!picked && <option value="">Choose a repository first</option>}
              {branches?.status === 'loading' && <option value={branch}>Loading branches…</option>}
              {branches?.status === 'ready' && branches.data.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          )}
          <span id={`${id}-branch-h`} className="hint">Pull requests are opened against it. Agentify never pushes to it.</span>
        </div>
        <div className="field">
          <label htmlFor={`${id}-folder`}>Theme folder</label>
          <input id={`${id}-folder`} className="input mono-input" value={folder} onChange={(e) => setFolder(e.target.value)}
            placeholder="Repository root" maxLength={200} disabled={busy} aria-describedby={`${id}-folder-h`} spellCheck={false} autoComplete="off" />
          <span id={`${id}-folder-h`} className="hint">Where <code>layout/</code>, <code>sections/</code> and <code>templates/</code> live. Empty for the root.</span>
        </div>
      </div>

      {error && <div className="banner fade-in" data-tone="danger" role="alert"><Icon name="alert" size={16} /><span>{error}</span></div>}

      <div className="set-actions">
        <button type="button" className="btn ghost" onClick={onDone} disabled={busy}>Cancel</button>
        <button type="submit" className="btn primary" disabled={!picked || !branch || busy || branches?.status !== 'ready'}>
          {busy && <span className="spinner" aria-hidden="true" />} {busy ? 'Checking…' : current ? 'Save' : 'Connect'}
        </button>
      </div>
    </form>
  );
}

/* ── a searchable repository list ──────────────────────────────────── */

const OWNER_REPO = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/;

function RepoPicker({ id, repos, value, disabled, onPick }: {
  id: string;
  repos: RepoOption[];
  value: { owner: string; repo: string } | null;
  disabled: boolean;
  onPick: (r: { owner: string; repo: string; defaultBranch?: string }) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(!value);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => (q ? repos.filter((r) => `${r.owner}/${r.repo}`.toLowerCase().includes(q)) : repos).slice(0, 100), [repos, q]);
  // A full owner/repo that is not in the list (more repositories than the list shows): offer it as typed.
  const typed = OWNER_REPO.exec(query.trim());
  const extra = typed && !repos.some((r) => `${r.owner}/${r.repo}`.toLowerCase() === q) ? { owner: typed[1]!, repo: typed[2]! } : null;
  const options: { owner: string; repo: string; defaultBranch?: string; private?: boolean; typed?: boolean }[] = [...shown, ...(extra ? [{ ...extra, typed: true }] : [])];

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function choose(i: number) {
    const o = options[i];
    if (!o) return;
    onPick({ owner: o.owner, repo: o.repo, defaultBranch: o.defaultBranch });
    setQuery('');
    setOpen(false);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(options.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter' && open) { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape' && open && value) { e.preventDefault(); setOpen(false); setQuery(''); }
  }

  if (!open && value) {
    return (
      <div className="repo-picked">
        <Icon name="github" size={14} />
        <span className="mono">{value.owner}/{value.repo}</span>
        <button type="button" className="btn ghost small" onClick={() => setOpen(true)} disabled={disabled}>Choose another</button>
      </div>
    );
  }

  return (
    <div className="repo-picker">
      <div className="repo-search">
        <Icon name="search" size={14} />
        <input id={id} className="input" role="combobox" aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list"
          aria-activedescendant={options[active] ? `${id}-o${active}` : undefined}
          placeholder={`Search ${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'}, or type owner/repo`}
          value={query} onChange={(e) => { setQuery(e.target.value); setOpen(true); }} onKeyDown={onKey} disabled={disabled}
          autoComplete="off" spellCheck={false} autoFocus />
      </div>
      <ul id={`${id}-list`} ref={listRef} className="repo-list" role="listbox" aria-label="Repositories">
        {options.map((o, i) => (
          <li key={`${o.owner}/${o.repo}`} id={`${id}-o${i}`} data-index={i} role="option" aria-selected={i === active}
            className="repo-opt" onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); choose(i); }}>
            <span className="mono repo-opt-name"><span className="repo-opt-owner">{o.owner}/</span>{o.repo}</span>
            {o.typed ? <span className="hint">Use this repository</span> : <>
              {o.private && <span title="Private"><Icon name="lock" size={12} /></span>}
              <span className="hint mono">{o.defaultBranch}</span>
            </>}
          </li>
        ))}
        {!options.length && <li className="repo-none hint">No repository matches “{query}”. Type the full owner/repo, or grant the app access to it on GitHub.</li>}
      </ul>
      {(repos.length >= REPO_LIST_CAP || shown.length === 100) && (
        <span className="hint">{repos.length >= REPO_LIST_CAP ? `Showing the first ${REPO_LIST_CAP} repositories the app can see. ` : ''}Search to narrow the list, or type owner/repo.</span>
      )}
      {value && <button type="button" className="btn ghost small repo-keep" onClick={() => { setOpen(false); setQuery(''); }}>Keep {value.owner}/{value.repo}</button>}
    </div>
  );
}
