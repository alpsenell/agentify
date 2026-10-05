/**
 * An in-memory Store for tests, with the same contract as storage.ts. Every
 * call yields to the event loop first, so concurrent callers interleave the
 * way they would against Redis.
 */
export function memoryStore() {
  const data = new Map();
  const tick = () => new Promise((r) => setImmediate(r));
  const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  return {
    data,
    async get(key) { await tick(); return data.has(key) ? clone(data.get(key)) : null; },
    async set(key, value) { await tick(); data.set(key, clone(value)); },
    async setIfAbsent(key, value) { await tick(); if (data.has(key)) return false; data.set(key, clone(value)); return true; },
    async delete(key) { await tick(); data.delete(key); },
    async keys(prefix) { await tick(); return [...data.keys()].filter((k) => k.startsWith(prefix)); },
    async getMany(keys) { await tick(); return keys.map((k) => (data.has(k) ? clone(data.get(k)) : null)); },
  };
}
