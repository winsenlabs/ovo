import { describe, expect, it } from 'vitest';
import {
  BoundedByteCache,
  CacheLoadInvalidatedError,
  CachePendingCapacityError,
  createCachePlugin,
} from '../src/index.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('BoundedByteCache', () => {
  it('isolates buffers and enforces TTL, LRU entry, byte, and maximum-entry budgets', () => {
    let now = 1_000;
    const cache = new BoundedByteCache(
      { ttlMs: 10, maxEntries: 2, maxBytes: 5, maxEntryBytes: 4, maxPending: 1 },
      () => now,
    );
    const original = Uint8Array.of(1, 2);
    expect(cache.set('a', 'workspace-a', original)).toBe(true);
    original[0] = 9;
    const first = cache.get('a', 'workspace-a')!;
    expect([...first]).toEqual([1, 2]);
    first[1] = 9;
    expect([...cache.get('a', 'workspace-a')!]).toEqual([1, 2]);

    expect(cache.set('b', 'workspace-a', Uint8Array.of(3, 4))).toBe(true);
    cache.get('a', 'workspace-a'); // a is most recently used
    expect(cache.set('c', 'workspace-a', Uint8Array.of(5, 6))).toBe(true);
    expect(cache.get('b', 'workspace-a')).toBeUndefined();
    expect([...cache.get('a', 'workspace-a')!]).toEqual([1, 2]);
    expect(cache.set('too-large', 'workspace-a', new Uint8Array(5))).toBe(false);

    const entryBound = new BoundedByteCache({ maxEntries: 1, maxBytes: 10, maxEntryBytes: 5 });
    entryBound.set('first', 'workspace-a', Uint8Array.of(1));
    entryBound.set('second', 'workspace-a', Uint8Array.of(2));
    expect(entryBound.get('first', 'workspace-a')).toBeUndefined();
    expect([...entryBound.get('second', 'workspace-a')!]).toEqual([2]);

    now += 11;
    expect(cache.get('a', 'workspace-a')).toBeUndefined();
    expect(cache.stats).toEqual({ entries: 0, bytes: 0, pending: 0 });
  });

  it('enforces workspace ownership even when callers reuse the exact key', async () => {
    const cache = new BoundedByteCache();
    cache.set('known-key', 'workspace-a', Uint8Array.of(11));
    expect(cache.get('known-key', 'workspace-b')).toBeUndefined();
    let loads = 0;
    const outcomes: string[] = [];
    const result = await cache.getOrLoad({
      key: 'known-key',
      workspaceId: 'workspace-b',
      onSource: (source) => outcomes.push(source),
      load: async () => {
        loads++;
        return Uint8Array.of(22);
      },
    });
    expect([...result.value]).toEqual([22]);
    expect(result.source).toBe('miss');
    expect(loads).toBe(1);
    expect(outcomes).toEqual(['miss']);
    expect(cache.get('known-key', 'workspace-a')).toBeUndefined();
    expect([...cache.get('known-key', 'workspace-b')!]).toEqual([22]);
  });

  it('coalesces identical loads while one waiter may cancel independently', async () => {
    const cache = new BoundedByteCache({ maxPending: 2 });
    const produced = deferred<Uint8Array>();
    let loads = 0;
    const firstAbort = new AbortController();
    const request = (signal?: AbortSignal) =>
      cache.getOrLoad({
        key: 'same',
        workspaceId: 'workspace-a',
        signal,
        load: async () => {
          loads += 1;
          return produced.promise;
        },
      });
    const first = request(firstAbort.signal);
    const second = request();
    firstAbort.abort(new DOMException('caller left', 'AbortError'));
    produced.resolve(Uint8Array.of(7, 8));

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).resolves.toMatchObject({ source: 'coalesced', stored: true });
    expect(loads).toBe(1);
    expect([...cache.get('same', 'workspace-a')!]).toEqual([7, 8]);
  });

  it('keeps all-aborted uncooperative producers pending and discards their late bytes', async () => {
    const cache = new BoundedByteCache({ maxPending: 1 });
    const produced = deferred<Uint8Array>();
    const abort = new AbortController();
    let producerAborted = false;
    const pending = cache.getOrLoad({
      key: 'abandoned',
      workspaceId: 'workspace-a',
      signal: abort.signal,
      load: (signal) => {
        signal.addEventListener('abort', () => (producerAborted = true), { once: true });
        return produced.promise;
      },
    });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(producerAborted).toBe(true);
    expect(cache.stats.pending).toBe(1);
    expect(() =>
      cache.getOrLoad({
        key: 'another',
        workspaceId: 'workspace-a',
        load: async () => Uint8Array.of(1),
      }),
    ).toThrow(CachePendingCapacityError);

    produced.resolve(Uint8Array.of(9));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cache.stats.pending).toBe(0);
    expect(cache.get('abandoned', 'workspace-a')).toBeUndefined();
  });

  it('is exposed as a bounded process-scope Cordis plugin', () => {
    const plugin = createCachePlugin();
    expect(plugin.manifest.scope).toBe('process');
    expect(plugin.manifest.provides).toEqual(['ovo.cache']);
  });

  it('invalidates one workspace, rejects waiters, and prevents late refill', async () => {
    const cache = new BoundedByteCache({ maxPending: 2 });
    cache.set('kept', 'workspace-b', Uint8Array.of(2));
    cache.set('removed', 'workspace-a', Uint8Array.of(1));
    const produced = deferred<Uint8Array>();
    let producerAborted = false;
    const pending = cache.getOrLoad({
      key: 'refill',
      workspaceId: 'workspace-a',
      load: (signal) => {
        signal.addEventListener('abort', () => (producerAborted = true), { once: true });
        return produced.promise;
      },
    });

    expect(cache.invalidateWorkspace('workspace-a')).toBe(1);
    await expect(pending).rejects.toBeInstanceOf(CacheLoadInvalidatedError);
    expect(producerAborted).toBe(true);
    expect([...cache.get('kept', 'workspace-b')!]).toEqual([2]);
    produced.resolve(Uint8Array.of(3));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cache.get('refill', 'workspace-a')).toBeUndefined();
  });
});
