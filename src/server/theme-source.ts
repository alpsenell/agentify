/**
 * Where the agents read a store's theme from. The repository is the source of
 * truth when one is connected (it is what a pull request will change);
 * otherwise the live theme on the Shopify store. With neither, the agents
 * work from stated assumptions.
 */
import type { Store, Workspace } from '../agency/types';
import { HttpError } from './auth';
import { listRepoThemeFiles, readRepoThemeFile, repoContext } from './github';
import { listThemeFiles, readThemeFile, storeContext } from './shopify';

export type ThemeSource = 'repo' | 'shopify' | 'none';

export const themeSource = (store: Store | null): ThemeSource => (store?.repo ? 'repo' : store?.shopify ? 'shopify' : 'none');

const none = () => new HttpError(409, 'no_theme_source', 'This request has no connected store or repository to read.');

/** Markdown an agent reads to understand the store: the shop itself, and the repository if there is one. */
export async function sourceContext(workspace: Workspace, store: Store | null): Promise<string> {
  if (!store || themeSource(store) === 'none') throw none();
  const parts: string[] = [];
  if (store.shopify) parts.push(await storeContext(workspace, store));
  if (store.repo) parts.push(await repoContext(workspace, store));
  return parts.join('\n\n');
}

export async function sourceListFiles(workspace: Workspace, store: Store | null, prefix?: string): Promise<string[]> {
  if (store?.repo) return listRepoThemeFiles(workspace, store, prefix);
  if (store?.shopify) return listThemeFiles(workspace, store, prefix);
  throw none();
}

export async function sourceReadFile(workspace: Workspace, store: Store | null, path: string): Promise<string> {
  if (store?.repo) return readRepoThemeFile(workspace, store, path);
  if (store?.shopify) return readThemeFile(workspace, store, path);
  throw none();
}
