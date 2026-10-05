/**
 * A workspace's stores: create, rename, delete. Each returns the workspace as
 * saved, which the routes send back to the app. Connecting a store to Shopify
 * lives in index.ts; deleting a store disconnects it first.
 */
import { randomUUID } from 'node:crypto';
import { STORE_ENVS, type Store, type StoreEnv, type Workspace } from '../../agency/types';
import { HttpError } from '../auth';
import { assertCanAddStore } from '../billing';
import { getWorkspace, listTasks, saveWorkspace } from '../repo';
import { disconnectStore } from './index';

function label(input: unknown): string {
  const value = typeof input === 'string' ? input.replace(/\s+/g, ' ').trim() : '';
  if (!value) throw new HttpError(400, 'invalid_label', 'Give the store a name.');
  if (value.length > 60) throw new HttpError(400, 'invalid_label', 'Keep the store name to 60 characters.');
  return value;
}

function storeEnv(input: unknown): StoreEnv {
  if (typeof input === 'string' && (STORE_ENVS as readonly string[]).includes(input)) return input as StoreEnv;
  throw new HttpError(400, 'invalid_env', `The environment must be one of: ${STORE_ENVS.join(', ')}.`);
}

const fresh = async (workspace: Workspace) => (await getWorkspace(workspace.id)) ?? workspace;

/** The store with this id in the workspace, or a 404. */
export function findStore(workspace: Workspace, id: string | undefined): Store {
  const store = workspace.stores.find((s) => s.id === id);
  if (!store) throw new HttpError(404, 'store_not_found', 'That store does not exist in this workspace.');
  return store;
}

export async function createStore(workspace: Workspace, input: { label: unknown; env: unknown }): Promise<Workspace> {
  const store: Store = {
    id: randomUUID(), label: label(input.label), env: input.env === undefined ? 'production' : storeEnv(input.env),
    shopify: null, repo: null, createdAt: Date.now(),
  };
  // Re-read so a change made a moment ago (a connection, another store) is not overwritten.
  const ws = await fresh(workspace);
  await assertCanAddStore(ws);
  if (ws.stores.some((s) => s.label.toLowerCase() === store.label.toLowerCase())) {
    throw new HttpError(409, 'duplicate_label', `There is already a store called “${store.label}”.`);
  }
  ws.stores.push(store);
  await saveWorkspace(ws);
  return ws;
}

export async function updateStore(workspace: Workspace, id: string | undefined, patch: { label?: unknown; env?: unknown }): Promise<Workspace> {
  const ws = await fresh(workspace);
  const store = findStore(ws, id);
  if (patch.label !== undefined) {
    const next = label(patch.label);
    if (ws.stores.some((s) => s.id !== store.id && s.label.toLowerCase() === next.toLowerCase())) {
      throw new HttpError(409, 'duplicate_label', `There is already a store called “${next}”.`);
    }
    store.label = next;
  }
  if (patch.env !== undefined) store.env = storeEnv(patch.env);
  await saveWorkspace(ws);
  return ws;
}

/** Delete a store, disconnecting it first. Refused while requests for it are still open. */
export async function deleteStore(workspace: Workspace, id: string | undefined): Promise<Workspace> {
  const store = findStore(await fresh(workspace), id);
  const open = (await listTasks(workspace.id)).filter((t) => t.storeId === store.id && !t.archived && t.phase !== 'done');
  if (open.length) {
    const numbers = open.slice(0, 5).map((t) => `#${t.number}`).join(', ');
    throw new HttpError(409, 'store_in_use',
      `“${store.label}” has ${open.length} open request${open.length > 1 ? 's' : ''} (${numbers}${open.length > 5 ? ', …' : ''}). Finish or archive ${open.length > 1 ? 'them' : 'it'} before deleting the store.`);
  }
  if (store.shopify) await disconnectStore(workspace, store);
  const ws = await fresh(workspace);
  ws.stores = ws.stores.filter((s) => s.id !== store.id);
  await saveWorkspace(ws);
  return ws;
}
