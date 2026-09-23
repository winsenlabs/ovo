import type { Clock } from '@winsendotai/ovo-contracts';

export interface OperationSignal {
  signal: AbortSignal;
  dispose(): void;
}

/** A child signal that aborts with the caller, or with a TimeoutError after `timeoutMs`. */
export function withDeadline(
  caller: AbortSignal,
  timeoutMs: number,
  message: string,
  clock?: Pick<Clock, 'setTimeout'>,
): OperationSignal {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new TypeError('timeoutMs must be a positive integer');
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(caller.reason);
  if (caller.aborted) abortFromCaller();
  else caller.addEventListener('abort', abortFromCaller, { once: true });
  const fire = () => controller.abort(new DOMException(message, 'TimeoutError'));
  let cancel: () => void;
  if (clock) cancel = clock.setTimeout(fire, timeoutMs);
  else {
    const timer = setTimeout(fire, timeoutMs);
    cancel = () => clearTimeout(timer);
  }
  return {
    signal: controller.signal,
    dispose() {
      cancel();
      caller.removeEventListener('abort', abortFromCaller);
    },
  };
}

export function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Provider operation cancelled', 'AbortError');
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** Resolves after `ms`, or rejects with the signal's reason. */
export function delay(
  ms: number,
  signal?: AbortSignal,
  clock?: Pick<Clock, 'setTimeout'>,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cancel();
      reject(abortError(signal!));
    };
    const done = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    let cancel: () => void;
    if (clock) cancel = clock.setTimeout(done, ms);
    else {
      const timer = setTimeout(done, ms);
      cancel = () => clearTimeout(timer);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A usage quantity as a decimal string (at most 6 fractional digits). */
export function decimal(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new TypeError('Usage value must be nonnegative');
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}
