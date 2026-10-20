export type CacheEntry<T> = { value: T; at: number };
const entries = new Map<string, CacheEntry<unknown>>();
const listeners = new Map<string, Set<() => void>>();
export function cacheGet<T>(key: string): CacheEntry<T> | undefined { return entries.get(key) as CacheEntry<T> | undefined; }
export function cacheSet<T>(key: string, value: T): void {
  entries.set(key, { value, at: Date.now() });
  for (const listener of listeners.get(key) ?? []) listener();
}
export function cacheInvalidate(key: string): void {
  entries.delete(key);
  for (const listener of listeners.get(key) ?? []) listener();
}
export function cacheSubscribe(key: string, listener: () => void): () => void {
  const set = listeners.get(key) ?? new Set<() => void>();
  set.add(listener); listeners.set(key, set);
  return () => { set.delete(listener); if (!set.size) listeners.delete(key); };
}
