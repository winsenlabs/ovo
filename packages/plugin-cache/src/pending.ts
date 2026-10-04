import {
  CacheLoadInvalidatedError,
  CacheKeyPendingError,
  CachePendingCapacityError,
  type ByteCacheLoadResult,
  type ByteCacheSource,
} from './types.ts';

interface Waiter {
  resolve(value: ByteCacheLoadResult): void;
  reject(error: unknown): void;
  cleanup(): void;
}

interface PendingLoad {
  key: string;
  workspaceId: string;
  controller: AbortController;
  waiters: Set<Waiter>;
  accepting: boolean;
  invalidated: boolean;
}

interface JoinRequest {
  key: string;
  workspaceId: string;
  signal?: AbortSignal;
  onSource?(source: ByteCacheSource): void;
  load(signal: AbortSignal): Promise<Uint8Array>;
  store(value: Uint8Array): boolean;
}

/** Coordinates producers and waiter cancellation; settled producers alone release pending capacity. */
export class PendingByteLoads {
  private readonly loads = new Map<string, PendingLoad>();

  constructor(private readonly maxPending: number) {}

  get count(): number {
    return this.loads.size;
  }

  join(request: JoinRequest): Promise<ByteCacheLoadResult> {
    if (request.signal?.aborted) return Promise.reject(abortError(request.signal));
    const existing = this.loads.get(request.key);
    if (existing?.accepting && existing.workspaceId === request.workspaceId) {
      request.onSource?.('coalesced');
      return this.addWaiter(existing, 'coalesced', request.signal);
    }
    if (existing) throw new CacheKeyPendingError();
    if (this.loads.size >= this.maxPending) throw new CachePendingCapacityError(this.maxPending);

    const pending: PendingLoad = {
      key: request.key,
      workspaceId: request.workspaceId,
      controller: new AbortController(),
      waiters: new Set(),
      accepting: true,
      invalidated: false,
    };
    this.loads.set(request.key, pending);
    request.onSource?.('miss');
    const result = this.addWaiter(pending, 'miss', request.signal);
    void this.run(pending, request.load, request.store);
    return result;
  }

  invalidateWorkspace(workspaceId: string): void {
    for (const pending of this.loads.values())
      if (pending.workspaceId === workspaceId) this.invalidate(pending);
  }

  invalidateAll(): void {
    for (const pending of this.loads.values()) this.invalidate(pending);
  }

  private addWaiter(
    pending: PendingLoad,
    source: ByteCacheSource,
    signal?: AbortSignal,
  ): Promise<ByteCacheLoadResult> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise<ByteCacheLoadResult>((resolve, reject) => {
      let settled = false;
      const onAbort = () => settle(() => reject(abortError(signal!)));
      const waiter: Waiter = {
        resolve: (value) => settle(() => resolve({ ...value, source })),
        reject: (error) => settle(() => reject(error)),
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      };
      const settle = (complete: () => void) => {
        if (settled) return;
        settled = true;
        waiter.cleanup();
        pending.waiters.delete(waiter);
        complete();
        if (pending.waiters.size === 0 && pending.accepting) {
          pending.accepting = false;
          pending.controller.abort(
            new DOMException('All cache load waiters aborted', 'AbortError'),
          );
        }
      };
      pending.waiters.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async run(
    pending: PendingLoad,
    load: (signal: AbortSignal) => Promise<Uint8Array>,
    store: (value: Uint8Array) => boolean,
  ): Promise<void> {
    try {
      const value = await load(pending.controller.signal);
      if (pending.invalidated || !pending.accepting || pending.waiters.size === 0) return;
      const stored = store(value);
      pending.accepting = false;
      if (this.loads.get(pending.key) === pending) this.loads.delete(pending.key);
      for (const waiter of [...pending.waiters])
        waiter.resolve({ value: value.slice(), source: 'miss', stored });
    } catch (error) {
      for (const waiter of [...pending.waiters]) waiter.reject(error);
    } finally {
      if (this.loads.get(pending.key) === pending) this.loads.delete(pending.key);
    }
  }

  private invalidate(pending: PendingLoad): void {
    if (pending.invalidated) return;
    pending.invalidated = true;
    pending.accepting = false;
    pending.controller.abort(new DOMException('Cache workspace invalidated', 'AbortError'));
    const error = new CacheLoadInvalidatedError();
    for (const waiter of [...pending.waiters]) waiter.reject(error);
  }
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Cache load waiter aborted', 'AbortError');
}
