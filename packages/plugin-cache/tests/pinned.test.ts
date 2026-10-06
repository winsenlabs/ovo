import { describe, expect, it } from 'vitest';
import { PinnedByteStore } from '../src/index.ts';

describe('PinnedByteStore', () => {
  it('keeps pinned values with no TTL and returns isolated copies', () => {
    const store = new PinnedByteStore(16);
    const original = Uint8Array.of(1, 2, 3);
    expect(store.pin('release-a', 'k1', 'workspace-a', original)).toBe(true);
    original[0] = 9;
    const read = store.get('k1', 'workspace-a')!;
    expect([...read]).toEqual([1, 2, 3]);
    read[1] = 9;
    expect([...store.get('k1', 'workspace-a')!]).toEqual([1, 2, 3]);
    expect(store.get('k1', 'workspace-b')).toBeUndefined();
    expect(store.stats).toEqual({ entries: 1, bytes: 3, owners: 1 });
  });

  it('frees a shared value only when its last owner releases it', () => {
    const store = new PinnedByteStore(16);
    store.pin('release-a', 'shared', 'workspace-a', Uint8Array.of(1, 2));
    store.pin('release-b', 'shared', 'workspace-a', Uint8Array.of(7, 7));
    store.pin('release-a', 'only-a', 'workspace-a', Uint8Array.of(3));
    expect(store.stats.bytes).toBe(3);
    expect(store.release('release-a')).toBe(1);
    expect(store.has('only-a', 'workspace-a')).toBe(false);
    expect([...store.get('shared', 'workspace-a')!]).toEqual([1, 2]);
    expect(store.release('release-b')).toBe(1);
    expect(store.stats).toEqual({ entries: 0, bytes: 0, owners: 0 });
  });

  it('refuses pins beyond the byte budget instead of evicting another owner', () => {
    const store = new PinnedByteStore(4);
    expect(store.pin('release-a', 'a', 'workspace-a', Uint8Array.of(1, 2, 3))).toBe(true);
    expect(store.pin('release-b', 'b', 'workspace-a', Uint8Array.of(1, 2))).toBe(false);
    expect(store.has('a', 'workspace-a')).toBe(true);
    expect(store.pin('release-b', 'a', 'workspace-b', Uint8Array.of(1))).toBe(false);
    expect(store.pin('release-b', 'empty', 'workspace-a', new Uint8Array())).toBe(false);
  });

  it('invalidates one workspace without touching another', () => {
    const store = new PinnedByteStore(16);
    store.pin('release-a', 'a', 'workspace-a', Uint8Array.of(1));
    store.pin('release-b', 'b', 'workspace-b', Uint8Array.of(2));
    expect(store.invalidateWorkspace('workspace-a')).toBe(1);
    expect(store.ownersOf()).toEqual(['release-b']);
    expect(store.stats).toEqual({ entries: 1, bytes: 1, owners: 1 });
    store.clear();
    expect(store.stats).toEqual({ entries: 0, bytes: 0, owners: 0 });
  });
});
