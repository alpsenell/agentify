/**
 * The app's store: who is signed in and the workspace's task summaries.
 * A plain module with useSyncExternalStore, no library. Views read it with
 * useApp(); everything that changes it lives here so optimistic updates and
 * their rollbacks happen in one place.
 */
import { useSyncExternalStore } from 'react';
import { api, ApiFailure } from './api';
import { toast } from './ui/toast';
import { nextAgent } from '../agency/flow';
import type { Me, Priority, StoreEnv, Task, TaskSummary, Workspace } from '../agency/types';

export type Session =
  | { status: 'checking' }
  | { status: 'signedOut' }
  /** The server could not be reached at all (not the same as signed out). */
  | { status: 'offline'; message: string }
  | { status: 'ready'; me: Me };

export interface AppState {
  session: Session;
  /** null until the first load finishes. */
  tasks: TaskSummary[] | null;
  tasksError: string | null;
}

let state: AppState = { session: { status: 'checking' }, tasks: null, tasksError: null };
const listeners = new Set<() => void>();

function set(patch: Partial<AppState>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}

const subscribe = (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); };
export const getState = () => state;
export const useApp = (): AppState => useSyncExternalStore(subscribe, getState);

/** The signed-in Me; only call where the shell has already rendered. */
export function useMe(): Me {
  const s = useApp().session;
  if (s.status !== 'ready') throw new Error('useMe outside a session');
  return s.me;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.');

/** A 401 from any call means the session ended: drop back to sign-in. */
function handleAuth(err: unknown): boolean {
  if (err instanceof ApiFailure && err.status === 401) {
    set({ session: { status: 'signedOut' }, tasks: null, tasksError: null });
    toast('Your session ended. Sign in again to continue.', 'warn');
    return true;
  }
  return false;
}

/* ── session ───────────────────────────────────────────────────────── */

export async function checkSession(): Promise<void> {
  try {
    const me = await api.me();
    set({ session: { status: 'ready', me } });
  } catch (err) {
    if (err instanceof ApiFailure && err.status === 401) set({ session: { status: 'signedOut' } });
    else set({ session: { status: 'offline', message: errorText(err) } });
  }
}

/** After sign-in or sign-up: load Me, and fail loudly if that does not work. */
export async function enterSession(): Promise<void> {
  const me = await api.me();
  set({ session: { status: 'ready', me }, tasks: null, tasksError: null });
}

export async function signOut(): Promise<void> {
  try {
    await api.logout();
  } catch (err) {
    if (!(err instanceof ApiFailure && err.status === 401)) {
      toast(errorText(err), 'danger');
      return;
    }
  }
  set({ session: { status: 'signedOut' }, tasks: null, tasksError: null });
}

function patchMe(fn: (me: Me) => Me) {
  if (state.session.status !== 'ready') return;
  set({ session: { status: 'ready', me: fn(state.session.me) } });
}

export async function saveWorkspace(patch: { name?: string; notes?: string }): Promise<Workspace> {
  try {
    const workspace = await api.updateWorkspace(patch);
    patchMe((me) => ({ ...me, workspace }));
    return workspace;
  } catch (err) {
    handleAuth(err);
    throw err;
  }
}

/** Replace the workspace in the session (every store/GitHub/billing call returns the updated one). */
export function setWorkspace(workspace: Workspace): void {
  patchMe((me) => ({ ...me, workspace }));
}

/** Reload Me (workspace, usage, capabilities) after something changed it out of band, e.g. an OAuth return. */
export async function refreshMe(): Promise<void> {
  if (state.session.status !== 'ready') return;
  try {
    const me = await api.me();
    set({ session: { status: 'ready', me } });
  } catch (err) {
    if (!handleAuth(err)) toast(`Could not refresh your account: ${errorText(err)}`, 'warn');
  }
}

/** Change the signed-in user's name or email preference. */
export async function saveMe(patch: { name?: string; notify?: boolean }): Promise<void> {
  try {
    const user = await api.updateMe(patch);
    patchMe((me) => ({ ...me, user }));
  } catch (err) {
    handleAuth(err);
    throw err;
  }
}

/** Run a call that returns the updated workspace, apply it, and surface a 401 as sign-out. */
async function withWorkspace(call: () => Promise<Workspace>): Promise<Workspace> {
  try {
    const workspace = await call();
    setWorkspace(workspace);
    return workspace;
  } catch (err) {
    handleAuth(err);
    throw err;
  }
}

export const createStore = (input: { label: string; env: StoreEnv }) => withWorkspace(() => api.createStore(input));
export const updateStore = (id: string, patch: { label?: string; env?: StoreEnv }) => withWorkspace(() => api.updateStore(id, patch));
export const deleteStore = (id: string) => withWorkspace(() => api.deleteStore(id));
export const connectShopifyToken = (storeId: string, input: { domain: string; token: string }) =>
  withWorkspace(() => api.connectShopifyToken(storeId, input));
export const disconnectShopify = (storeId: string) => withWorkspace(() => api.disconnectShopify(storeId));

/* ── tasks ─────────────────────────────────────────────────────────── */

let inflight: Promise<void> | null = null;
/** Whether the last background refresh failed, so a flaky network toasts once, not every tick. */
let refreshFailing = false;

export function refreshTasks(): Promise<void> {
  if (state.session.status !== 'ready') return Promise.resolve();
  inflight ??= api.listTasks()
    .then((tasks) => {
      refreshFailing = false;
      set({ tasks, tasksError: null });
    })
    .catch((err: unknown) => {
      if (handleAuth(err)) return;
      if (state.tasks === null) set({ tasksError: errorText(err) });
      else if (!refreshFailing) toast(`Could not refresh requests: ${errorText(err)}`, 'warn');
      refreshFailing = true;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

/** The list row for a full task, matching the server's own summary. */
export function summarise(task: Task): TaskSummary {
  const last = task.messages.at(-1) ?? null;
  return {
    id: task.id, number: task.number, storeId: task.storeId, title: task.title, priority: task.priority, phase: task.phase,
    waiting: task.waiting, paused: task.paused, archived: task.archived, createdAt: task.createdAt, updatedAt: task.updatedAt,
    nextAgent: nextAgent(task), running: task.lockedUntil > Date.now(),
    lastMessage: last ? { from: last.from, at: last.at, text: last.text.length > 220 ? `${last.text.slice(0, 219)}…` : last.text } : null,
    messageCount: task.messages.length,
  };
}

function upsert(summary: TaskSummary) {
  const list = state.tasks ?? [];
  const i = list.findIndex((t) => t.id === summary.id);
  set({ tasks: i === -1 ? [summary, ...list] : list.map((t, j) => (j === i ? summary : t)) });
}

/** A full task changed (from the request view, or a create): update every list in place. */
export function applyTask(task: Task): void {
  upsert(summarise(task));
}

export async function createTask(input: { message: string; storeId?: string | null; attachments?: string[] }): Promise<Task> {
  try {
    const task = await api.createTask(input);
    applyTask(task);
    return task;
  } catch (err) {
    handleAuth(err);
    throw err;
  }
}

/** Change priority or archive a task optimistically; roll back and say so if the server refuses. */
export async function patchTask(id: string, patch: { priority?: Priority; archived?: boolean }): Promise<void> {
  const before = state.tasks?.find((t) => t.id === id);
  if (!before) return;
  upsert({ ...before, ...patch, ...(patch.archived ? { nextAgent: null, waiting: 'none' as const } : {}) });
  try {
    applyTask(await api.updateTask(id, patch));
  } catch (err) {
    const current = state.tasks?.find((t) => t.id === id);
    if (current) upsert(before);
    if (!handleAuth(err)) toast(`Could not update #${before.number}: ${errorText(err)}`, 'danger');
  }
}
