import { ByteCacheEntries } from './entries.ts';
import { PendingByteLoads } from './pending.ts';
import {
  resolveByteCacheLimits,
  type ByteCache,
  type ByteCacheLimits,
  type ByteCacheLoadRequest,
  type ByteCacheLoadResult,
  type ByteCacheStats,
} from './types.ts';

export class BoundedByteCache implements ByteCache {
  private readonly entries: ByteCacheEntries;
  private readonly pending: PendingByteLoads;

  constructor(limits: ByteCacheLimits = {}, now: () => number = Date.now) {
    const resolved = resolveByteCacheLimits(limits);
    this.entries = new ByteCacheEntries(resolved, now);
    this.pending = new PendingByteLoads(resolved.maxPending);
  }

  get stats(): ByteCacheStats {
    return { ...this.entries.stats, pending: this.pending.count };
  }

  get(key: string, workspaceId: string): Uint8Array | undefined {
    return this.entries.get(key, workspaceId);
  }

  set(key: string, workspaceId: string, value: Uint8Array): boolean {
    return this.entries.set(key, workspaceId, value);
  }

  getOrLoad(request: ByteCacheLoadRequest): Promise<ByteCacheLoadResult> {
    const hit = this.entries.get(request.key, request.workspaceId);
    if (hit) {
      request.onSource?.('hit');
      return Promise.resolve({ value: hit, source: 'hit', stored: true });
    }
    return this.pending.join({
      ...request,
      store: (value) => this.entries.set(request.key, request.workspaceId, value),
    });
  }

  invalidateWorkspace(workspaceId: string): number {
    this.pending.invalidateWorkspace(workspaceId);
    return this.entries.invalidateWorkspace(workspaceId);
  }

  clear(): void {
    this.pending.invalidateAll();
    this.entries.clear();
  }
}
