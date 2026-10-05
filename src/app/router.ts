/**
 * A tiny history router for the app, which lives under /dashboard.
 *
 *   /dashboard            the request list
 *   /dashboard/board      the same requests as a board by phase
 *   /dashboard/t/:id      one request, opened over the list
 *   /dashboard/team       the agents
 *   /dashboard/settings   workspace, stores, GitHub, plan and members
 *   /dashboard/join/:token   accept an invitation (shown signed out)
 */
import { useSyncExternalStore } from 'react';

export const BASE = '/dashboard';

export type Route =
  | { name: 'list' }
  | { name: 'board' }
  | { name: 'task'; id: string }
  | { name: 'team' }
  | { name: 'settings' }
  | { name: 'join'; token: string }
  | { name: 'notFound' };

export function parse(pathname: string): Route {
  const rest = pathname.replace(/\/+$/, '').slice(BASE.length).replace(/^\//, '');
  if (rest === '') return { name: 'list' };
  if (rest === 'board') return { name: 'board' };
  if (rest === 'team') return { name: 'team' };
  if (rest === 'settings') return { name: 'settings' };
  const join = /^join\/([A-Za-z0-9_-]{16,128})$/.exec(rest);
  if (join) return { name: 'join', token: join[1]! };
  const task = /^t\/([0-9a-f-]{36})$/.exec(rest);
  return task ? { name: 'task', id: task[1]! } : { name: 'notFound' };
}

export const paths = {
  list: () => BASE,
  board: () => `${BASE}/board`,
  task: (id: string) => `${BASE}/t/${id}`,
  team: () => `${BASE}/team`,
  settings: () => `${BASE}/settings`,
  join: (token: string) => `${BASE}/join/${token}`,
};

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

export function navigate(path: string, { replace = false } = {}): void {
  if (path === window.location.pathname) return;
  if (replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
  notify();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  window.addEventListener('popstate', fn);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('popstate', fn);
  };
}

/** The current pathname, re-rendering on navigation. */
export const usePathname = (): string => useSyncExternalStore(subscribe, () => window.location.pathname);

/** onClick for an <a href> that should navigate in-app (modified clicks still open a new tab). */
export function linkClick(event: React.MouseEvent<HTMLAnchorElement>): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(event.currentTarget.pathname);
}
