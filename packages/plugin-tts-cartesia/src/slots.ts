import type { Clock } from '@winsendotai/ovo-contracts';
import { abortError } from '@winsendotai/ovo-plugin-kit';

/**
 * Pauses before the 1st and 2nd retry of a context that failed retryably (429
 * `concurrency_limited`, 5xx, a dropped socket) before its first audio. After audio has been heard
 * a retry would repeat words, so the failure surfaces instead.
 */
export const RETRY_PAUSES_MS: readonly number[] = Object.freeze([250, 750]);

/** Resolves after `ms` on the injected clock; rejects at once when `signal` aborts. */
export function pause(clock: Pick<Clock, 'setTimeout'>, ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal));
    const onAbort = () => {
      cancel();
      reject(abortError(signal));
    };
    const cancel = clock.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Runs `fn` once when `signal` aborts; the returned function detaches it. */
export function whenAborted(signal: AbortSignal, fn: () => void): () => void {
  signal.addEventListener('abort', fn, { once: true });
  return () => signal.removeEventListener('abort', fn);
}

/** The running code-point count after adding `text`, or a TypeError past `limit`. */
export function withinLimit(count: number, text: string, limit: number): number {
  const next = count + [...text].length;
  if (next > limit) throw new TypeError(`Cartesia TTS text must contain 1–${limit} characters`);
  return next;
}

/**
 * A per-session cap on live contexts. Sonic counts concurrency as unique active contexts, account
 * wide (Pro 3, Startup 5, Scale 15), and OVO prewarms clips in parallel, so one call holding more
 * than the plan allows would earn 429s for every call. Waiters are served first come, first served.
 */
export class ContextSlots {
  private held = 0;
  private readonly queue: { admit: () => void; signal: AbortSignal }[] = [];

  constructor(readonly limit: number) {}

  get inUse(): number {
    return this.held;
  }

  /** Holds one slot until the returned release runs (idempotent). */
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.held < this.limit) this.held += 1;
    else await this.wait(signal);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.handOn();
    };
  }

  private wait(signal: AbortSignal): Promise<void> {
    const turn = Promise.withResolvers<void>();
    const waiter = { admit: turn.resolve, signal };
    const leave = () => {
      this.queue.splice(this.queue.indexOf(waiter), 1);
      turn.reject(abortError(signal));
    };
    signal.addEventListener('abort', leave, { once: true });
    waiter.admit = () => {
      signal.removeEventListener('abort', leave);
      turn.resolve();
    };
    this.queue.push(waiter);
    return turn.promise;
  }

  /** A released slot passes straight to the oldest waiter, or goes back to the pool. */
  private handOn(): void {
    const next = this.queue.shift();
    if (next) next.admit();
    else this.held -= 1;
  }
}
