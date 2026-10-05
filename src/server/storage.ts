/**
 * Key-value persistence for the agency backend. Two drivers behind one
 * interface:
 *
 * - Redis over REST (Upstash / Vercel KV), used when KV_REST_API_URL and
 *   KV_REST_API_TOKEN (or the UPSTASH_REDIS_REST_* pair) are set. This is the
 *   production driver: serverless functions have no durable disk.
 * - JSON files under .data/, used otherwise. Local development only.
 *
 * Values are JSON documents. Keys are namespaced by the callers in repo.ts.
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface Store {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  /** Write only if the key does not exist. Returns false when it already does. */
  setIfAbsent<T>(key: string, value: T): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Every key starting with `prefix`. */
  keys(prefix: string): Promise<string[]>;
  getMany<T>(keys: string[]): Promise<(T | null)[]>;
}

const env = (name: string): string | undefined => process.env[name] ?? (import.meta.env?.[name] as string | undefined);

/* ── Redis REST ────────────────────────────────────────────────────── */

function redisStore(url: string, token: string): Store {
  const call = async <R>(...command: (string | number)[]): Promise<R> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    const body = (await res.json()) as { result?: R; error?: string };
    if (!res.ok || body.error) throw new Error(`Storage error: ${body.error ?? res.status}`);
    return body.result as R;
  };
  const parse = <T>(raw: string | null): T | null => (raw == null ? null : (JSON.parse(raw) as T));

  return {
    get: async <T>(key: string) => parse<T>(await call<string | null>('GET', key)),
    set: async (key, value) => { await call('SET', key, JSON.stringify(value)); },
    setIfAbsent: async (key, value) => (await call<string | null>('SET', key, JSON.stringify(value), 'NX')) === 'OK',
    delete: async (key) => { await call('DEL', key); },
    keys: async (prefix) => {
      const found: string[] = [];
      let cursor = '0';
      do {
        const [next, batch] = await call<[string, string[]]>('SCAN', cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
        found.push(...batch);
        cursor = next;
      } while (cursor !== '0');
      return found;
    },
    getMany: async <T>(keys: string[]) => (keys.length ? (await call<(string | null)[]>('MGET', ...keys)).map((r) => parse<T>(r)) : []),
  };
}

/* ── local files ───────────────────────────────────────────────────── */

function fileStore(dir: string): Store {
  // Keys contain ":"; encode them so each key is one flat, safe file name.
  const file = (key: string) => path.join(dir, `${encodeURIComponent(key)}.json`);
  const ready = mkdir(dir, { recursive: true });

  const get = async <T>(key: string): Promise<T | null> => {
    try {
      return JSON.parse(await readFile(file(key), 'utf8')) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  };
  const set = async <T>(key: string, value: T) => {
    await ready;
    // Write then rename, so a reader never sees a half-written document.
    const tmp = `${file(key)}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(value));
    await rename(tmp, file(key));
  };

  return {
    get,
    set,
    setIfAbsent: async (key, value) => {
      await ready;
      try {
        await writeFile(file(key), JSON.stringify(value), { flag: 'wx' });
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw err;
      }
    },
    delete: async (key) => { await rm(file(key), { force: true }); },
    keys: async (prefix) => {
      await ready;
      return (await readdir(dir))
        .filter((f) => f.endsWith('.json'))
        .map((f) => decodeURIComponent(f.slice(0, -5)))
        .filter((k) => k.startsWith(prefix));
    },
    getMany: (keys) => Promise.all(keys.map((k) => get(k))) as Promise<never[]>,
  };
}

/* ── selection ─────────────────────────────────────────────────────── */

let store: Store | undefined;

export function getStore(): Store {
  if (store) return store;
  const url = env('KV_REST_API_URL') ?? env('UPSTASH_REDIS_REST_URL');
  const token = env('KV_REST_API_TOKEN') ?? env('UPSTASH_REDIS_REST_TOKEN');
  if (url && token) return (store = redisStore(url, token));
  if (env('VERCEL')) {
    throw new Error('No database configured. Add a Redis (Upstash / Vercel KV) integration so KV_REST_API_URL and KV_REST_API_TOKEN are set.');
  }
  return (store = fileStore(path.resolve(env('AGENTIFY_DATA_DIR') ?? '.data')));
}
