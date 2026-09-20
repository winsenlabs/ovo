import type { ResolvedByteCacheLimits } from './types.ts';

interface CacheEntry {
  workspaceId: string;
  value: Uint8Array;
  expiresAt: number;
}

/** Owns TTL, byte accounting and LRU order. Values never escape without a copy. */
export class ByteCacheEntries {
  private readonly entries = new Map<string, CacheEntry>();
  private totalBytes = 0;

  constructor(
    private readonly limits: ResolvedByteCacheLimits,
    private readonly now: () => number,
  ) {}

  get stats(): { entries: number; bytes: number } {
    this.purgeExpired();
    return { entries: this.entries.size, bytes: this.totalBytes };
  }

  get(key: string): Uint8Array | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.delete(key, entry);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value.slice();
  }

  set(key: string, workspaceId: string, value: Uint8Array): boolean {
    if (value.byteLength > this.limits.maxEntryBytes || value.byteLength > this.limits.maxBytes)
      return false;
    const old = this.entries.get(key);
    if (old) this.delete(key, old);
    const entry = {
      workspaceId,
      value: value.slice(),
      expiresAt: this.now() + this.limits.ttlMs,
    };
    this.entries.set(key, entry);
    this.totalBytes += entry.value.byteLength;
    this.evictToBudget();
    return this.entries.get(key) === entry;
  }

  invalidateWorkspace(workspaceId: string): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.workspaceId !== workspaceId) continue;
      this.delete(key, entry);
      removed += 1;
    }
    return removed;
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  private purgeExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.delete(key, entry);
    }
  }

  private evictToBudget(): void {
    while (this.entries.size > this.limits.maxEntries || this.totalBytes > this.limits.maxBytes) {
      const oldest = this.entries.entries().next().value as [string, CacheEntry] | undefined;
      if (!oldest) return;
      this.delete(oldest[0], oldest[1]);
    }
  }

  private delete(key: string, entry: CacheEntry): void {
    if (!this.entries.delete(key)) return;
    this.totalBytes -= entry.value.byteLength;
  }
}
