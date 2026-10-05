/**
 * Settings → GitHub: install the Agentify GitHub App on the workspace's
 * GitHub account, see the installation, disconnect it. Also turns the
 * install callback's ?github=<outcome> into a toast and cleans the URL.
 * Repositories are bound per store (RepoBinding.tsx).
 */
import { useEffect, useId, useState } from 'react';
import type { Me } from '../../../agency/types';
import { api } from '../../api';
import { refreshMe, setWorkspace } from '../../state';
import { Icon } from '../../ui/Icon';
import { fullDate } from '../../ui/format';
import { toast, type ToastTone } from '../../ui/toast';
import './github.css';

/** What /api/github/callback (and /install) report back. */
const OUTCOME: Record<string, [string, ToastTone]> = {
  connected: ['GitHub connected. Now connect a repository to each store.', 'ok'],
  unchanged: ['GitHub is connected. Repository access changes on GitHub apply right away.', 'ok'],
  requested: ['Installation requested. An owner of that GitHub organisation has to approve it; once they have, start the installation here again to finish.', 'info'],
  invalid_state: ['That GitHub link expired or was started from another session, so nothing was connected. Start the installation again from here (also if an organisation owner just approved your request).', 'warn'],
  not_owner: ['Only the workspace owner can connect GitHub.', 'warn'],
  no_access: ['GitHub could not confirm that your GitHub account can access that installation, so it was not connected. Sign in to GitHub as someone who manages the app on that account and try again.', 'danger'],
  no_code: ['GitHub did not send an authorization code. The GitHub App must have “Request user authorization (OAuth) during installation” turned on; ask whoever runs this server.', 'danger'],
  not_configured: ['GitHub is not configured on this server.', 'warn'],
  signed_out: ['Your session ended during the installation. Start it again from here.', 'warn'],
  error: ['Connecting GitHub failed. Try again in a moment.', 'danger'],
};

const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.');

/** Read and clear ?github= once, on the first mount after the redirect. */
function useCallbackOutcome() {
  useEffect(() => {
    const url = new URL(window.location.href);
    const outcome = url.searchParams.get('github');
    if (!outcome) return;
    url.searchParams.delete('github');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}#github`);
    const [message, tone] = OUTCOME[outcome] ?? OUTCOME.error!;
    toast(message, tone);
    if (outcome === 'connected' || outcome === 'unchanged') void refreshMe();
    document.getElementById('github')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);
}

export default function GitHubSection({ me }: { me: Me }) {
  useCallbackOutcome();
  const id = useId();
  const install = me.workspace.github;
  const isOwner = me.user.role === 'owner';
  const boundStores = me.workspace.stores.filter((s) => s.repo);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function disconnect() {
    setBusy(true);
    try {
      setWorkspace(await api.disconnectGithub());
      setConfirming(false);
      toast('GitHub disconnected. The app is still installed on GitHub; uninstall it there to revoke its access.', 'ok');
    } catch (err) {
      toast(`Could not disconnect GitHub: ${errorText(err)}`, 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="github" className="set-section card fade-in" aria-labelledby={`${id}-t`}>
      <div className="set-intro">
        <h2 id={`${id}-t`} className="section-title"><Icon name="github" size={16} /> GitHub</h2>
        <p className="section-sub">
          Keep your theme in a GitHub repository? Connect it and the agents read the theme from the repository, and approved
          work arrives as a <strong>pull request</strong> on its own branch. Nothing is merged for you.
        </p>
        <p className="section-sub">Each store can use its own repository, branch and theme folder.</p>
      </div>

      <div className="set-body">
        {!me.capabilities.github ? (
          <div className="banner" role="note">
            <Icon name="info" size={16} />
            <span>GitHub is not configured on this server, so repositories can't be connected yet. Whoever runs Agentify needs to set up the GitHub App first.</span>
          </div>
        ) : !install ? (
          <div className="gh-connect fade-in">
            <ul className="gh-points">
              <li><Icon name="check" size={14} /><span>The agents read your theme from the repository's base branch, so new code fits what's there.</span></li>
              <li><Icon name="check" size={14} /><span>Approved work is committed to an <code>agentify/…</code> branch with a pull request describing it.</span></li>
              <li><Icon name="lock" size={14} /><span>Agentify never pushes to your base branch and never merges. You choose which repositories the app can see.</span></li>
            </ul>
            {isOwner ? (
              <div className="set-actions">
                <span className="hint">You'll pick the account and repositories on GitHub.</span>
                <a className="btn primary" href={api.githubInstallUrl()}><Icon name="github" size={14} /> Install the GitHub App</a>
              </div>
            ) : (
              <p className="hint">Only the workspace owner can connect GitHub.</p>
            )}
          </div>
        ) : (
          <div className="shop fade-in">
            <div className="shop-head">
              <span className="shop-mark" aria-hidden="true"><Icon name="github" size={16} /></span>
              <div className="shop-id">
                <strong>{install.account}</strong>
                <a href={`https://github.com/${encodeURIComponent(install.account)}`} target="_blank" rel="noopener">github.com/{install.account}</a>
              </div>
              <span className="tag" data-tone="ok">Connected</span>
            </div>
            <dl className="shop-meta">
              <dt>Since</dt><dd>{fullDate(install.connectedAt)}</dd>
              <dt>Stores</dt>
              <dd>
                {boundStores.length
                  ? `${boundStores.length} of ${me.workspace.stores.length} ${me.workspace.stores.length === 1 ? 'store has' : 'stores have'} a repository: ${boundStores.map((s) => s.label).join(', ')}`
                  : 'No store has a repository yet. Connect one on each store card.'}
              </dd>
            </dl>
            {isOwner && !confirming && (
              <div className="set-actions">
                <a className="btn ghost" href={api.githubInstallUrl()}>Change repository access <Icon name="external" size={13} /></a>
                <button type="button" className="btn danger" onClick={() => setConfirming(true)}>Disconnect</button>
              </div>
            )}
            {isOwner && confirming && (
              <div className="banner gh-confirm pop-in" data-tone="warn" role="alertdialog" aria-labelledby={`${id}-c`}>
                <Icon name="alert" size={16} />
                <div className="gh-confirm-body">
                  <p id={`${id}-c`}>
                    <strong>Disconnect GitHub?</strong>{' '}
                    {boundStores.length ? `${boundStores.length === 1 ? 'One store loses its' : `${boundStores.length} stores lose their`} repository, and ` : ''}
                    the agents stop reading from GitHub and opening pull requests. Open pull requests stay on GitHub.
                  </p>
                  <p className="hint">This does not uninstall the app from {install.account}. To revoke its access, uninstall it in GitHub settings → Applications.</p>
                  <div className="set-actions">
                    <button type="button" className="btn ghost" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
                    <button type="button" className="btn danger" onClick={() => void disconnect()} disabled={busy} autoFocus>
                      {busy && <span className="spinner" aria-hidden="true" />} Disconnect
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
