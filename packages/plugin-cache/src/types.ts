export interface ByteCacheLimits {
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  maxEntryBytes?: number;
  maxPending?: number;
}

export interface ResolvedByteCacheLimits {
  ttlMs: number;
  maxEntries: number;
  maxBytes: number;
  maxEntryBytes: number;
  maxPending: number;
}

export type ByteCacheSource = 'hit' | 'miss' | 'coalesced';

export interface ByteCacheLoadRequest {
  key: string;
  workspaceId: string;
  signal?: AbortSignal;
  onSource?(source: ByteCacheSource): void;
  load(signal: AbortSignal): Promise<Uint8Array>;
}

export interface ByteCacheLoadResult {
  value: Uint8Array;
  source: ByteCacheSource;
  stored: boolean;
}

export interface ByteCacheStats {
  entries: number;
  bytes: number;
  pending: number;
}

export interface ByteCache {
  get(key: string): Uint8Array | undefined;
  set(key: string, workspaceId: string, value: Uint8Array): boolean;
  getOrLoad(request: ByteCacheLoadRequest): Promise<ByteCacheLoadResult>;
  invalidateWorkspace(workspaceId: string): number;
  clear(): void;
  readonly stats: ByteCacheStats;
}

export class CachePendingCapacityError extends Error {
  constructor(maxPending: number) {
    super(`Byte cache has reached its ${maxPending} pending load limit`);
    this.name = 'CachePendingCapacityError';
  }
}

export class CacheLoadInvalidatedError extends Error {
  constructor() {
    super('Byte cache load was invalidated');
    this.name = 'CacheLoadInvalidatedError';
  }
}

export class CacheKeyPendingError extends Error {
  constructor() {
    super('A canceled or invalidated load for this cache key is still settling');
    this.name = 'CacheKeyPendingError';
  }
}

export function resolveByteCacheLimits(input: ByteCacheLimits = {}): ResolvedByteCacheLimits {
  const limits = {
    ttlMs: input.ttlMs ?? 300_000,
    maxEntries: input.maxEntries ?? 256,
    maxBytes: input.maxBytes ?? 32 * 1024 * 1024,
    maxEntryBytes: input.maxEntryBytes ?? 2 * 1024 * 1024,
    maxPending: input.maxPending ?? 16,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new TypeError(`${name} must be a positive integer`);
  }
  if (limits.maxEntryBytes > limits.maxBytes)
    throw new TypeError('maxEntryBytes must not exceed maxBytes');
  return limits;
}
