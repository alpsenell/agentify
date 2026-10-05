/**
 * The signed-in app: sidebar, a top bar and view per route, the New request
 * composer, and the request sheet that opens over the list or board. Owns
 * the keyboard shortcuts and keeps task summaries live.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Me, Phase } from '../../agency/types';
import { navigate, parse, paths, usePathname, type Route } from '../router';
import { useApp } from '../state';
import { Icon } from '../ui/Icon';
import { NewRequest, loadDraft, saveDraft } from './NewRequest';
import { Sidebar } from './Sidebar';
import { TaskSheet } from './TaskSheet';
import { TopBar } from './TopBar';
import { useLiveTasks } from './useLiveTasks';
import { ListView } from '../views/ListView';
import { BoardView } from '../views/BoardView';
import { TeamView } from '../views/TeamView';
import { SettingsView } from '../views/SettingsView';
import './shell.css';

type ViewName = Exclude<Route['name'], 'task'>;

const COLLAPSE_KEY = 'agentify:sidebar-collapsed';

const readCollapsed = () => { try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; } };

/** A key press inside a field belongs to the field. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

export function Shell({ me }: { me: Me }) {
  const pathname = usePathname();
  const route = parse(pathname);
  const { tasks, tasksError } = useApp();
  useLiveTasks();

  // The view under an open request: whatever was showing before it opened (the list on a direct load).
  const [background, setBackground] = useState<ViewName>(route.name === 'task' ? 'list' : route.name);
  const view: ViewName = route.name === 'task' ? background : route.name;
  /** Whether closing the sheet can simply go back in history to the view underneath. */
  const backCloses = useRef(false);
  const lastRoute = useRef<Route>(route);
  useEffect(() => {
    const prev = lastRoute.current;
    lastRoute.current = route;
    if (route.name !== 'task') { setBackground(route.name); backCloses.current = false; }
    else if (prev.name !== 'task') backCloses.current = true;
    else if (prev.id !== route.id) backCloses.current = false;
  }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeTask = useCallback(() => {
    if (backCloses.current) window.history.back();
    else navigate(background === 'notFound' || background === 'join' ? paths.list() : paths[background]());
  }, [background]);

  // Sidebar: collapsed rail on desktop (remembered), drawer on small screens.
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawer, setDrawer] = useState(false);
  const toggleCollapsed = () => setCollapsed((c) => {
    try { localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1'); } catch { /* not remembered */ }
    return !c;
  });
  useEffect(() => { setDrawer(false); }, [pathname]);

  // New request composer and its draft.
  const [newOpen, setNewOpen] = useState(false);
  const [draft, setDraftState] = useState(loadDraft);
  const setDraft = useCallback((text: string) => { setDraftState(text); saveDraft(text); }, []);
  const openNew = useCallback((prefill?: string) => {
    if (prefill !== undefined) setDraft(prefill);
    setNewOpen(true);
  }, [setDraft]);

  // Search, phase and store filters, shared by list and board.
  const [query, setQuery] = useState('');
  const [phase, setPhase] = useState<Phase | 'all'>('all');
  const stores = me.workspace.stores;
  const [storeChoice, setStore] = useState<string | 'all'>('all');
  // A store deleted (or the second store removed) while filtered falls back to everything.
  const store = stores.length > 1 && stores.some((s) => s.id === storeChoice) ? storeChoice : 'all';
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.key === 'Escape' && drawer) { setDrawer(false); return; }
      // Shortcuts only apply to the page itself, not while a dialog or menu is open.
      if (document.querySelector('.modal-layer[data-state="open"], .menu-list')) return;
      if (e.key === 'c' || e.key === 'n') { e.preventDefault(); openNew(); }
      else if (e.key === '/' && searchRef.current) { e.preventDefault(); searchRef.current.focus(); searchRef.current.select(); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer, openNew]);

  const search = { value: query, onChange: setQuery, inputRef: searchRef };
  const top = { onNew: () => openNew(), onMenu: () => setDrawer(true) };

  return (
    <div className="shell" data-collapsed={collapsed}>
      <Sidebar
        me={me} tasks={tasks} view={view} openTaskId={route.name === 'task' ? route.id : null}
        collapsed={collapsed} onToggleCollapsed={toggleCollapsed}
        drawerOpen={drawer} onCloseDrawer={() => setDrawer(false)} onNew={() => openNew()}
      />
      <div className="main" inert={drawer}>
        {!me.llmReady && (
          <div className="banner llm-banner" data-tone="warn" role="status">
            <Icon name="alert" size={16} />
            <span><strong>The agents can't run yet.</strong> The server has no Claude credentials, so requests wait until it does.<span className="llm-more"> You can still write requests and set up your workspace.</span></span>
          </div>
        )}

        {view === 'list' && (
          <>
            <TopBar title="Requests" switcher="list" search={search} {...top} />
            <ListView tasks={tasks} error={tasksError} query={query} phase={phase} onPhase={setPhase} stores={stores} store={store} onStore={setStore}
              onNew={openNew} onClearSearch={() => { setQuery(''); setPhase('all'); setStore('all'); }} />
          </>
        )}
        {view === 'board' && (
          <>
            <TopBar title="Requests" switcher="board" search={search} {...top} />
            <BoardView tasks={tasks} error={tasksError} query={query} stores={stores} store={store} onStore={setStore} onNew={openNew} />
          </>
        )}
        {view === 'team' && (
          <>
            <TopBar title="Team" subtitle="Six agents, one hand-off at a time" {...top} />
            <TeamView tasks={tasks} />
          </>
        )}
        {view === 'settings' && (
          <>
            <TopBar title="Settings" {...top} />
            <SettingsView me={me} />
          </>
        )}
        {view === 'notFound' && (
          <>
            <TopBar title="Not found" {...top} />
            <div className="empty fade-in">
              <h3>There's nothing at this address</h3>
              <p>The request may have been deleted, or the link is mistyped.</p>
              <button type="button" className="btn" onClick={() => navigate(paths.list())}>Back to requests</button>
            </div>
          </>
        )}
      </div>

      <TaskSheet taskId={route.name === 'task' ? route.id : null} me={me} onClose={closeTask} />
      <NewRequest open={newOpen} onClose={() => setNewOpen(false)} draft={draft} onDraft={setDraft} llmReady={me.llmReady} stores={stores} />
    </div>
  );
}
