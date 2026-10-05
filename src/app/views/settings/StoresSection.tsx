/**
 * Settings → Stores: the workspace's stores as cards. Each card has the
 * store's name and environment, its Shopify connection (one-click OAuth when
 * the server has the Agentify Shopify app, a pasted custom-app token
 * otherwise or under "Advanced"), and the GitHub repository binding, which is
 * a teammate's RepoBinding component loaded lazily. Also turns the OAuth
 * callback's return flags into a toast.
 *
 * Since January 1, 2026 merchants cannot create new custom apps in the
 * Shopify admin (https://changelog.shopify.com/posts/legacy-custom-apps-can-t-be-created-after-january-1-2026);
 * apps made before then keep working, so pasting a token is only for those.
 */
import { Component, lazy, Suspense, useEffect, useId, useRef, useState, type ComponentType, type FormEvent, type ReactNode } from 'react';
import { STORE_ENVS, type Me, type Store, type StoreEnv } from '../../../agency/types';
import { api, ApiFailure } from '../../api';
import { connectShopifyToken, createStore, deleteStore, disconnectShopify, updateStore } from '../../state';
import { EnvTag } from '../../ui/bits';
import { ENV_LABEL, fullDate } from '../../ui/format';
import { Icon } from '../../ui/Icon';
import { Menu } from '../../ui/Menu';
import { toast } from '../../ui/toast';
import './stores.css';

const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.');

/* ── the teammate's repository binding, loaded tolerantly ──────────── */

type RepoProps = { me: Me; store: Store };
const repoModules = import.meta.glob<{ default: ComponentType<RepoProps> }>('./RepoBinding.tsx');
const repoLoader = repoModules['./RepoBinding.tsx'];
const RepoBinding: ComponentType<RepoProps> | null = repoLoader ? lazy(repoLoader) : null;

class RepoBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return <p className="hint" role="alert">The repository settings could not be shown: {this.state.error.message}</p>;
  }
}

/* ── OAuth return flags ────────────────────────────────────────────── */

/** What the callback's ?shopify_error=<code> means, in words. */
const OAUTH_ERRORS: Record<string, string> = {
  not_configured: 'Connecting with Shopify isn’t set up on this server.',
  owner_only: 'Only the workspace owner can connect stores.',
  store_not_found: 'That store no longer exists in this workspace.',
  invalid_shop: 'That isn’t a valid .myshopify.com address.',
  hmac: 'Shopify’s reply could not be verified, so nothing was connected. Try again.',
  expired: 'The connection took too long and expired. Start it again.',
  state: 'The connection was started in another session or browser. Start it again from here.',
  denied: 'Shopify didn’t authorize the app, so nothing was connected.',
  signed_out: 'You were signed out while connecting. Sign in and try again.',
  shopify_missing_scopes: 'Shopify didn’t grant theme access. Connect again and approve every permission Shopify asks for.',
  shopify_domain_taken: 'That shop is already connected to another store in this workspace. Disconnect it there first.',
  shopify_token_rejected: 'Shopify rejected the new authorization. Try connecting again.',
  shopify_store_unavailable: 'That shop is frozen or locked in Shopify, so it can’t be connected right now.',
  shopify_store_not_found: 'No Shopify store answered at that address.',
  failed: 'Something went wrong connecting to Shopify. Try again.',
};

const RETURN_KEYS = ['shopify', 'shopify_error', 'store'];

/** Read and remove the flags the OAuth callback put on the URL. Leaves other sections' flags alone. */
function takeReturnFlags(): { connected: boolean; error: string | null; storeId: string | null } | null {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('shopify') && !params.has('shopify_error')) return null;
  const result = { connected: params.get('shopify') === 'connected', error: params.get('shopify_error'), storeId: params.get('store') };
  RETURN_KEYS.forEach((k) => params.delete(k));
  const query = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash || '#stores'}`);
  return result;
}

/* ── section ───────────────────────────────────────────────────────── */

export function StoresSection({ me }: { me: Me }) {
  const stores = me.workspace.stores;
  const owner = me.user.role === 'owner';
  const [adding, setAdding] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const id = useId();

  useEffect(() => {
    const flags = takeReturnFlags();
    if (!flags) return;
    const store = stores.find((s) => s.id === flags.storeId);
    if (flags.connected) {
      toast(store?.shopify ? `Connected ${store.shopify.shopName} to ${store.label}.` : 'Store connected.', 'ok');
    } else {
      toast(OAUTH_ERRORS[flags.error ?? ''] ?? OAUTH_ERRORS.failed!, 'danger');
    }
    if (store) {
      setHighlight(store.id);
      requestAnimationFrame(() => document.getElementById(`store-${store.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="set-section stores-section card fade-in" aria-labelledby={`${id}-t`}>
      <div className="set-intro">
        <h2 id={`${id}-t`} className="section-title"><Icon name="store" size={16} /> Stores</h2>
        <p className="section-sub">
          The Shopify stores your requests are built for. Add one per shop or environment (say, staging and production) and
          pick which one each request is for.
        </p>
        <p className="section-sub">
          Connected, the agents read the live theme so the code fits it, and Relay installs approved work on a new,
          <strong> unpublished preview theme</strong>. Your live theme is never changed; you publish when you’re ready.
        </p>
      </div>

      <div className="set-body">
        {stores.length === 0 && !adding && (
          <div className="stores-empty">
            <span className="stores-empty-mark" aria-hidden="true"><Icon name="store" size={20} /></span>
            <h3>Add the store your team builds for</h3>
            <p>
              Without a store the team still works: it states its assumptions about your theme and hands you the finished files to
              install yourself. With one, it reads your theme first and can put the result on a preview theme for you.
            </p>
            {owner && <button type="button" className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Add a store</button>}
          </div>
        )}

        {stores.map((s) => <StoreCard key={s.id} me={me} store={s} highlight={highlight === s.id} />)}

        {owner && (adding
          ? <AddStore first={stores.length === 0} onDone={() => setAdding(false)} />
          : stores.length > 0 && (
            <div className="set-actions">
              <button type="button" className="btn" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Add another store</button>
            </div>
          ))}
      </div>
    </section>
  );
}

function AddStore({ first, onDone }: { first: boolean; onDone: () => void }) {
  const [label, setLabel] = useState('');
  const [env, setEnv] = useState<StoreEnv>('production');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const labelError = !label.trim() ? 'Give the store a name, e.g. the brand or “Staging”.' : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (labelError || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createStore({ label: label.trim(), env });
      toast(`${label.trim()} added. Connect it to Shopify next.`, 'ok');
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="store-add fade-in" onSubmit={submit} noValidate aria-labelledby={`${id}-t`}>
      <h3 id={`${id}-t`} className="store-add-title">{first ? 'Add a store' : 'Add another store'}</h3>
      <div className="store-add-fields">
        <div className="field">
          <label htmlFor={`${id}-l`}>Name</label>
          <input id={`${id}-l`} className="input" value={label} maxLength={60} placeholder="e.g. Northwind, or Staging" data-autofocus autoFocus
            onChange={(e) => setLabel(e.target.value)} disabled={busy}
            aria-invalid={tried && labelError ? true : undefined} aria-describedby={tried && labelError ? `${id}-l-err` : undefined} />
          {tried && labelError && <span id={`${id}-l-err`} className="error-text">{labelError}</span>}
        </div>
        <div className="field">
          <label htmlFor={`${id}-e`}>Environment</label>
          <select id={`${id}-e`} className="select" value={env} onChange={(e) => setEnv(e.target.value as StoreEnv)} disabled={busy}>
            {STORE_ENVS.map((v) => <option key={v} value={v}>{ENV_LABEL[v]}</option>)}
          </select>
        </div>
      </div>
      {error && <div className="banner fade-in" data-tone="danger" role="alert">{error}</div>}
      <div className="set-actions">
        <button type="button" className="btn ghost" onClick={onDone} disabled={busy}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy && <span className="spinner" aria-hidden="true" />} {busy ? 'Adding…' : 'Add store'}
        </button>
      </div>
    </form>
  );
}

/* ── one store ─────────────────────────────────────────────────────── */

function StoreCard({ me, store, highlight }: { me: Me; store: Store; highlight: boolean }) {
  const owner = me.user.role === 'owner';
  const [mode, setMode] = useState<'view' | 'rename' | 'delete'>('view');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  async function setEnv(env: StoreEnv) {
    if (env === store.env) return;
    try {
      await updateStore(store.id, { env });
      toast(`${store.label} is now marked ${ENV_LABEL[env].toLowerCase()}.`, 'ok');
    } catch (err) {
      toast(`Could not change the environment: ${errorText(err)}`, 'danger');
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await deleteStore(store.id);
      toast(`${store.label} deleted.`, 'ok');
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <article id={`store-${store.id}`} className="store-card" data-highlight={highlight || undefined} aria-labelledby={`${id}-n`}>
      <header className="store-head">
        {mode === 'rename' ? (
          <RenameStore store={store} onDone={() => setMode('view')} />
        ) : (
          <>
            <h3 id={`${id}-n`} className="store-name">{store.label}</h3>
            <EnvTag env={store.env} />
            {owner && mode === 'view' && (
              <Menu
                label={`Actions for ${store.label}`} heading={store.label}
                trigger={<span aria-hidden="true" className="store-more">•••</span>} triggerClassName="btn ghost icon small store-menu"
                items={[
                  { key: 'rename', label: 'Rename', icon: <Icon name="edit" size={14} />, onSelect: () => setMode('rename') },
                  ...STORE_ENVS.map((env) => ({ key: env, label: `Mark as ${ENV_LABEL[env].toLowerCase()}`, checked: store.env === env, onSelect: () => void setEnv(env) })),
                  { key: 'delete', label: 'Delete store', icon: <Icon name="trash" size={14} />, tone: 'danger' as const, onSelect: () => { setError(null); setMode('delete'); } },
                ]}
              />
            )}
          </>
        )}
      </header>

      {mode === 'delete' && (
        <div className="store-confirm fade-in" role="group" aria-label={`Delete ${store.label}`}>
          <p>
            Delete <strong>{store.label}</strong>?{store.shopify ? ' Its Shopify connection and saved token are removed first.' : ''} Your themes are not
            touched, and finished requests keep their history.
          </p>
          {error && <div className="banner" data-tone="danger" role="alert">{error}</div>}
          <div className="set-actions">
            <button type="button" className="btn ghost" onClick={() => setMode('view')} disabled={busy}>Cancel</button>
            <button type="button" className="btn danger" onClick={() => void remove()} disabled={busy} autoFocus>
              {busy && <span className="spinner" aria-hidden="true" />} Delete store
            </button>
          </div>
        </div>
      )}

      <ShopifyBlock me={me} store={store} />

      {RepoBinding && (
        <div className="store-block">
          <RepoBoundary>
            <Suspense fallback={<span className="skeleton" style={{ width: '60%', height: 14 }} />}>
              <RepoBinding me={me} store={store} />
            </Suspense>
          </RepoBoundary>
        </div>
      )}
    </article>
  );
}

function RenameStore({ store, onDone }: { store: Store; onDone: () => void }) {
  const [label, setLabel] = useState(store.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next = label.trim();
    if (!next) { setError('The name cannot be empty.'); return; }
    if (next === store.label) { onDone(); return; }
    setBusy(true);
    try {
      await updateStore(store.id, { label: next });
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <form className="store-rename" onSubmit={submit} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onDone(); } }}>
      <label htmlFor={`${id}-r`} className="sr-only">Store name</label>
      <input id={`${id}-r`} className="input" value={label} maxLength={60} autoFocus onChange={(e) => { setLabel(e.target.value); setError(null); }} disabled={busy}
        aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-r-err` : undefined} />
      <button type="button" className="btn ghost small" onClick={onDone} disabled={busy}>Cancel</button>
      <button type="submit" className="btn primary small" disabled={busy}>{busy && <span className="spinner" aria-hidden="true" />} Save</button>
      {error && <span id={`${id}-r-err`} className="error-text store-rename-err">{error}</span>}
    </form>
  );
}

/* ── the Shopify connection of one store ───────────────────────────── */

function ShopifyBlock({ me, store }: { me: Me; store: Store }) {
  const shop = store.shopify;
  const owner = me.user.role === 'owner';
  const oauth = me.capabilities.shopifyOAuth;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function disconnect() {
    setBusy(true);
    try {
      await disconnectShopify(store.id);
      setConfirming(false);
      toast(`${store.label} disconnected. The saved access token was deleted.`, 'ok');
    } catch (err) {
      toast(`Could not disconnect: ${errorText(err)}`, 'danger');
    } finally {
      setBusy(false);
    }
  }

  if (!shop) {
    return (
      <div className="store-block">
        <div className="store-block-head"><span className="store-block-title">Shopify</span><span className="tag">Not connected</span></div>
        {!owner ? <p className="hint">The workspace owner can connect this store.</p>
          : oauth ? (
            <>
              <OAuthConnect store={store} />
              <details className="store-advanced">
                <summary>Advanced: use a token from an existing custom app</summary>
                <TokenConnect store={store} oauth />
              </details>
            </>
          ) : <TokenConnect store={store} oauth={false} />}
      </div>
    );
  }

  // write_themes implies read_themes; without it the connection is read-only.
  const readOnly = !shop.scopes.includes('write_themes');
  return (
    <div className="store-block">
      <div className="store-shop">
        <span className="shop-mark" aria-hidden="true"><Icon name="check" size={16} /></span>
        <div className="shop-id">
          <strong>{shop.shopName}</strong>
          <a href={`https://${shop.domain}/admin`} target="_blank" rel="noopener">{shop.domain}</a>
        </div>
        {readOnly ? <span className="tag" data-tone="warn">Read-only</span> : <span className="tag" data-tone="ok">Connected</span>}
      </div>
      <dl className="shop-meta">
        <dt>Connected</dt><dd>{fullDate(shop.connectedAt)} · {shop.via === 'oauth' ? 'with the Agentify Shopify app' : 'with a custom-app token'}</dd>
        <dt>Access</dt><dd className="shop-scopes">{shop.scopes.map((s) => <span key={s} className="tag mono">{s}</span>)}</dd>
      </dl>
      {readOnly && (
        <div className="banner" data-tone="warn" role="status">
          <span>
            <strong>Read-only:</strong> without <code>write_themes</code> Relay can’t deploy previews; the agents still read your theme and you get the files to install.{' '}
            {shop.via === 'oauth'
              ? 'Disconnect and connect again, approving every permission Shopify asks for.'
              : 'Add the scope in your custom app’s Admin API settings, update the app, and connect again with its token.'}
          </span>
        </div>
      )}
      {owner && (
        <div className="set-actions">
          {confirming ? (
            <>
              <span className="hint">Agents stop reading this store’s theme and deploys stop. Your themes are not touched.</span>
              <button type="button" className="btn ghost" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
              <button type="button" className="btn danger" onClick={() => void disconnect()} disabled={busy} autoFocus>
                {busy && <span className="spinner" aria-hidden="true" />} Disconnect
              </button>
            </>
          ) : (
            <button type="button" className="btn ghost danger-text" onClick={() => setConfirming(true)}>Disconnect Shopify</button>
          )}
        </div>
      )}
    </div>
  );
}

/** What a merchant types into "my-store", "my-store.myshopify.com", a store or admin URL → "my-store.myshopify.com", or null. */
export function shopDomain(input: string): string | null {
  let v = input.trim().toLowerCase().replace(/^https?:\/\//, '');
  const admin = /^admin\.shopify\.com\/store\/([^/?#]+)/.exec(v);
  if (admin) v = `${admin[1]}.myshopify.com`;
  v = v.replace(/[/?#].*$/, '');
  if (v && !v.includes('.')) v = `${v}.myshopify.com`;
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(v) && !v.startsWith('-') && !/-\.myshopify/.test(v) ? v : null;
}

const DOMAIN_HELP = 'Use the store’s .myshopify.com address (Shopify admin → Settings → Domains), not your custom domain.';

function OAuthConnect({ store }: { store: Store }) {
  const [domain, setDomain] = useState('');
  const [tried, setTried] = useState(false);
  const [going, setGoing] = useState(false);
  const id = useId();
  const d = shopDomain(domain);
  const domainError = !domain.trim() ? 'Enter your store’s address.' : !d ? DOMAIN_HELP : null;

  function go(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (!d) return;
    setGoing(true);
    window.location.assign(api.shopifyOAuthUrl(store.id, d));
  }

  return (
    <form className="shop-form" onSubmit={go} noValidate>
      <p className="hint shop-form-lead">
        Shopify asks you to approve the Agentify app on your store, then brings you back here. It needs theme access to read your theme and
        create preview themes; product counts help the agents but are optional.
      </p>
      <div className="field">
        <label htmlFor={`${id}-d`}>Store address</label>
        <div className="shop-oauth-row">
          <input id={`${id}-d`} className="input" placeholder="my-store.myshopify.com" value={domain} autoComplete="off" spellCheck={false}
            onChange={(e) => setDomain(e.target.value)} disabled={going}
            aria-invalid={tried && domainError ? true : undefined} aria-describedby={`${id}-d-msg`} />
          <button type="submit" className="btn primary" disabled={going}>
            {going ? <span className="spinner" aria-hidden="true" /> : <Icon name="link" size={14} />} {going ? 'Opening Shopify…' : 'Connect with Shopify'}
          </button>
        </div>
        {tried && domainError ? <span id={`${id}-d-msg`} className="error-text">{domainError}</span>
          : <span id={`${id}-d-msg`} className="hint">{d && domain.trim() !== d ? `Connecting ${d}` : 'e.g. my-store, or paste your Shopify admin URL'}</span>}
      </div>
    </form>
  );
}

/** Which form field a server error code belongs to; anything else shows under the form. */
const TOKEN_FIELD: Record<string, 'domain' | 'token'> = {
  shopify_invalid_domain: 'domain', shopify_store_not_found: 'domain', shopify_domain_taken: 'domain',
  shopify_invalid_token: 'token', shopify_token_rejected: 'token', shopify_missing_scopes: 'token',
};

function TokenConnect({ store, oauth }: { store: Store; oauth: boolean }) {
  const [domain, setDomain] = useState('');
  const [token, setToken] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ domain?: string; token?: string }>({});
  const tokenRef = useRef<HTMLInputElement>(null);
  const id = useId();

  const d = shopDomain(domain);
  const domainError = !domain.trim() ? 'Enter your store’s .myshopify.com address.' : !d ? DOMAIN_HELP : null;
  const tokenError = !token.trim() ? 'Paste the Admin API access token.' : null;
  const domainShown = (tried && domainError) || fieldError.domain || null;
  const tokenShown = (tried && tokenError) || fieldError.token || null;

  async function connect(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (domainError || tokenError || busy || !d) return;
    setBusy(true);
    setError(null);
    setFieldError({});
    try {
      const ws = await connectShopifyToken(store.id, { domain: d, token: token.trim() });
      setToken('');
      const conn = ws.stores.find((s) => s.id === store.id)?.shopify;
      toast(conn ? `Connected ${conn.shopName} to ${store.label}.` : 'Store connected.', 'ok');
    } catch (err) {
      const field = err instanceof ApiFailure ? TOKEN_FIELD[err.code] : undefined;
      if (field) {
        setFieldError({ [field]: errorText(err) });
        if (field === 'token') tokenRef.current?.focus();
      } else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="token-connect">
      {oauth ? (
        <p className="hint">
          For stores that already have a custom app made in their Shopify admin. Shopify stopped allowing new ones on January 1, 2026, so
          for any other store use <strong>Connect with Shopify</strong> above.
        </p>
      ) : (
        <div className="banner" data-tone="info" role="note">
          <Icon name="info" size={15} />
          <span>
            <strong>This only works if your store already has a custom app.</strong> Shopify stopped letting stores create new custom apps in the admin
            on January 1, 2026; ones made before then still work. If yours has none, ask whoever runs this Agentify server to set up the Agentify
            Shopify app, which connects in one click. Until then the team works without a store and delivers files.
          </span>
        </div>
      )}
      <ol className="steps">
        <li>In Shopify admin open <strong>Settings → Apps and sales channels → Develop apps</strong> and open your existing custom app.</li>
        <li>
          Under <strong>Configuration → Admin API integration</strong>, make sure <code>read_themes</code> and <code>write_themes</code> (needed to deploy
          previews) are ticked. Optionally add <code>read_products</code>, <code>read_markets</code> and <code>read_locales</code> so the agents know more
          about your store. Save, and update the app if Shopify asks.
        </li>
        <li>Under <strong>API credentials</strong>, copy the <strong>Admin API access token</strong> (it starts with <code>shpat_</code>). Shopify shows it once; if you no longer have it, generate a new one there.</li>
      </ol>
      <form className="shop-form" onSubmit={connect} noValidate>
        <div className="field">
          <label htmlFor={`${id}-d`}>Store address</label>
          <input id={`${id}-d`} className="input" placeholder="my-store.myshopify.com" value={domain} autoComplete="off" spellCheck={false}
            onChange={(e) => { setDomain(e.target.value); setFieldError((f) => ({ ...f, domain: undefined })); }} disabled={busy}
            aria-invalid={domainShown ? true : undefined} aria-describedby={domainShown ? `${id}-d-err` : undefined} />
          {domainShown && <span id={`${id}-d-err`} className="error-text">{domainShown}</span>}
        </div>
        <div className="field">
          <label htmlFor={`${id}-k`}>Admin API access token</label>
          <input id={`${id}-k`} ref={tokenRef} className="input mono-input" type="password" placeholder="shpat_…" value={token} autoComplete="off" spellCheck={false}
            onChange={(e) => { setToken(e.target.value); setFieldError((f) => ({ ...f, token: undefined })); }} disabled={busy}
            aria-invalid={tokenShown ? true : undefined} aria-describedby={`${id}-k-msg`} />
          {tokenShown ? <span id={`${id}-k-msg`} className="error-text">{tokenShown}</span>
            : <span id={`${id}-k-msg`} className="hint">Stored encrypted on the server and never shown again, not even to you.</span>}
        </div>
        {error && <div className="banner fade-in" data-tone="danger" role="alert">{error}</div>}
        <div className="set-actions">
          <button type="submit" className="btn primary" disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />} {busy ? 'Checking the store…' : 'Connect with token'}
          </button>
        </div>
      </form>
    </div>
  );
}
