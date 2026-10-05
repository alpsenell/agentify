/**
 * The left sidebar: workspace header, primary nav, the "Requests" space with
 * every open request, and the user menu. Collapses to an icon rail on
 * desktop and becomes a drawer on small screens.
 */
import { useState } from 'react';
import type { Me, TaskSummary } from '../../agency/types';
import { linkClick, paths, type Route } from '../router';
import { signOut } from '../state';
import { Icon, type IconName } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import { PhaseDot, StoreTag } from '../ui/bits';
import { byPriority, groupOf, storeFor } from '../ui/format';
import { navigate } from '../router';
import { openSettings } from '../views/SettingsView';

interface Props {
  me: Me;
  tasks: TaskSummary[] | null;
  /** The route the main area shows (the list/board under an open request). */
  view: Route['name'];
  openTaskId: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  drawerOpen: boolean;
  onCloseDrawer: () => void;
  onNew: () => void;
}

const NAV: { name: Route['name']; label: string; icon: IconName; href: string }[] = [
  { name: 'list', label: 'Requests', icon: 'list', href: paths.list() },
  { name: 'board', label: 'Board', icon: 'board', href: paths.board() },
  { name: 'team', label: 'Team', icon: 'team', href: paths.team() },
  { name: 'settings', label: 'Settings', icon: 'settings', href: paths.settings() },
];

export function Sidebar({ me, tasks, view, openTaskId, collapsed, onToggleCollapsed, drawerOpen, onCloseDrawer, onNew }: Props) {
  const [spaceOpen, setSpaceOpen] = useState(true);
  const open = (tasks ?? []).filter((t) => !t.archived && t.phase !== 'done');
  const needsYou = open.filter((t) => groupOf(t) === 'needs');
  // Needs-you first, then the rest; stable within each.
  const ordered = [...needsYou.sort(byPriority), ...open.filter((t) => groupOf(t) !== 'needs').sort(byPriority)];
  const ws = me.workspace;

  const go = (e: React.MouseEvent<HTMLAnchorElement>) => { linkClick(e); onCloseDrawer(); };

  return (
    <>
      <div className="drawer-scrim" data-open={drawerOpen} onClick={onCloseDrawer} aria-hidden="true" />
      <aside className="sidebar" data-collapsed={collapsed} data-drawer={drawerOpen} aria-label="Sidebar">
        <div className="sb-head">
          <Menu
            label="Workspace menu" align="start" heading={ws.name}
            triggerClassName="sb-workspace"
            trigger={
              <>
                <span className="sb-ws-mark" aria-hidden="true">{ws.name.trim()[0]?.toUpperCase() ?? 'A'}</span>
                <span className="sb-ws-name sb-text">{ws.name}</span>
                <Icon name="down" size={14} className="sb-text sb-ws-caret" />
              </>
            }
            items={[
              { key: 'settings', label: 'Workspace settings', icon: <Icon name="settings" size={14} />, onSelect: () => { navigate(paths.settings()); onCloseDrawer(); } },
              {
                key: 'store', icon: <Icon name="store" size={14} />,
                label: storesLabel(ws.stores),
                onSelect: () => { openSettings('stores'); onCloseDrawer(); },
              },
              { key: 'out', label: 'Sign out', icon: <Icon name="logout" size={14} />, tone: 'danger', onSelect: () => void signOut() },
            ]}
          />
          <button type="button" className="btn ghost icon small sb-collapse" onClick={onToggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-pressed={collapsed} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            <Icon name="sidebar" size={15} />
          </button>
          <button type="button" className="btn ghost icon small sb-drawer-close" onClick={onCloseDrawer} aria-label="Close menu">
            <Icon name="close" size={15} />
          </button>
        </div>

        <button type="button" className="sb-new" onClick={() => { onCloseDrawer(); onNew(); }} title="New request (C)">
          <Icon name="plus" size={15} />
          <span className="sb-text">New request</span>
          <kbd className="sb-text">C</kbd>
        </button>

        <nav className="sb-nav" aria-label="Primary">
          {NAV.map((n) => (
            <a key={n.name} href={n.href} onClick={go} className="sb-link" aria-current={view === n.name ? 'page' : undefined} title={collapsed ? n.label : undefined}>
              <Icon name={n.icon} />
              <span className="sb-text">{n.label}</span>
              {n.name === 'list' && needsYou.length > 0 && <span className="sb-badge" aria-label={`${needsYou.length} need you`}>{needsYou.length}</span>}
            </a>
          ))}
        </nav>

        <div className="sb-space">
          <button type="button" className="sb-space-head" aria-expanded={spaceOpen} onClick={() => setSpaceOpen((o) => !o)}>
            <Icon name="chevron" size={12} className="sb-caret" />
            <span className="sb-text">Requests</span>
            {needsYou.length > 0 && (
              <span className="sb-space-needs sb-text" title={`${needsYou.length} waiting on you`}>{needsYou.length} need you</span>
            )}
          </button>
          <div className="sb-space-body" data-open={spaceOpen}>
            <ul className="sb-tasks" aria-label="Open requests">
              {tasks === null && [0, 1, 2].map((i) => (
                <li key={i} className="sb-task-skel"><span className="skeleton" style={{ width: `${70 - i * 12}%`, height: 10 }} /></li>
              ))}
              {tasks !== null && ordered.length === 0 && <li className="sb-empty sb-text">No open requests</li>}
              {ordered.map((t) => {
                const mine = groupOf(t) === 'needs';
                const store = storeFor(ws.stores, t.storeId);
                return (
                  <li key={t.id}>
                    <a href={paths.task(t.id)} onClick={go} className="sb-task" aria-current={openTaskId === t.id ? 'page' : undefined} title={t.title}>
                      <PhaseDot phase={t.phase} />
                      <span className="sb-task-title sb-text">{t.title}</span>
                      {store && <span className="sb-text sb-task-store"><StoreTag store={store} compact /></span>}
                      {mine && <span className="sb-you sb-text" aria-label="Needs you">you</span>}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>

        <div className="sb-foot">
          <Menu
            label="Account menu" align="start" side="top" triggerClassName="sb-user"
            trigger={
              <>
                <span className="avatar small" data-who="client" aria-hidden="true">{me.user.name.trim()[0]?.toUpperCase() ?? '?'}</span>
                <span className="sb-user-text sb-text">
                  <span className="sb-user-name">{me.user.name}</span>
                  <span className="sb-user-mail">{me.user.email}</span>
                </span>
              </>
            }
            items={[
              { key: 'settings', label: 'Settings', icon: <Icon name="settings" size={14} />, onSelect: () => { navigate(paths.settings()); onCloseDrawer(); } },
              { key: 'site', label: 'agentify.plus', icon: <Icon name="external" size={14} />, onSelect: () => { window.open('/', '_blank', 'noopener'); } },
              { key: 'out', label: 'Sign out', icon: <Icon name="logout" size={14} />, tone: 'danger', onSelect: () => void signOut() },
            ]}
          />
        </div>
      </aside>
    </>
  );
}

/** The workspace menu's store entry: what is connected, or the next thing to do. */
function storesLabel(stores: Me['workspace']['stores']): string {
  if (stores.length === 0) return 'Add a store';
  if (stores.length > 1) return `Stores (${stores.length})`;
  const only = stores[0]!;
  return only.shopify ? `Store: ${only.shopify.shopName}` : `Connect ${only.label}`;
}
