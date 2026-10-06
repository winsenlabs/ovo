interface PinnedEntry {
  workspaceId: string;
  value: Uint8Array;
  owners: Set<string>;
}

export interface PinnedByteStoreStats {
  entries: number;
  bytes: number;
  owners: number;
}

/**
 * Bytes that live as long as an owner (a release) keeps them: no TTL and no LRU churn. A value
 * shared by two owners is stored once and freed when the last owner lets go. New pins beyond the
 * byte budget are refused rather than evicting another owner's values.
 */
export class PinnedByteStore {
  private readonly entries = new Map<string, PinnedEntry>();
  private readonly owners = new Map<string, Set<string>>();
  private totalBytes = 0;

  constructor(readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new TypeError('maxBytes must be a positive integer');
  }

  get stats(): PinnedByteStoreStats {
    return { entries: this.entries.size, bytes: this.totalBytes, owners: this.owners.size };
  }

  get(key: string, workspaceId: string): Uint8Array | undefined {
    const entry = this.entries.get(key);
    return entry && entry.workspaceId === workspaceId ? entry.value.slice() : undefined;
  }

  has(key: string, workspaceId: string): boolean {
    return this.entries.get(key)?.workspaceId === workspaceId;
  }

  /** False when the value would exceed the budget, or the key belongs to another workspace. */
  pin(owner: string, key: string, workspaceId: string, value: Uint8Array): boolean {
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.workspaceId !== workspaceId) return false;
      existing.owners.add(owner);
      this.ownedKeys(owner).add(key);
      return true;
    }
    if (!value.byteLength || this.totalBytes + value.byteLength > this.maxBytes) return false;
    this.entries.set(key, { workspaceId, value: value.slice(), owners: new Set([owner]) });
    this.totalBytes += value.byteLength;
    this.ownedKeys(owner).add(key);
    return true;
  }

  /** Drops one owner's references; values no other owner holds are freed. */
  release(owner: string): number {
    const keys = this.owners.get(owner);
    if (!keys) return 0;
    this.owners.delete(owner);
    let freed = 0;
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (!entry) continue;
      entry.owners.delete(owner);
      if (entry.owners.size) continue;
      this.entries.delete(key);
      this.totalBytes -= entry.value.byteLength;
      freed += 1;
    }
    return freed;
  }

  ownersOf(): string[] {
    return [...this.owners.keys()];
  }

  invalidateWorkspace(workspaceId: string): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.workspaceId !== workspaceId) continue;
      this.entries.delete(key);
      this.totalBytes -= entry.value.byteLength;
      for (const owner of entry.owners) this.owners.get(owner)?.delete(key);
      removed += 1;
    }
    for (const [owner, keys] of this.owners) if (!keys.size) this.owners.delete(owner);
    return removed;
  }

  clear(): void {
    this.entries.clear();
    this.owners.clear();
    this.totalBytes = 0;
  }

  private ownedKeys(owner: string): Set<string> {
    let keys = this.owners.get(owner);
    if (!keys) this.owners.set(owner, (keys = new Set()));
    return keys;
  }
}
