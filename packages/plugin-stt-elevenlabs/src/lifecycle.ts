/** A promise settled from outside; a rejection nobody awaits is not reported as unhandled. */
export interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

export function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  // swallow-ok: whoever awaits the promise gets the rejection; this only avoids an unhandled one.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** Runs `fn` once when `signal` aborts; the returned function detaches it. */
export function onAbort(signal: AbortSignal, fn: () => void): () => void {
  signal.addEventListener('abort', fn, { once: true });
  return () => signal.removeEventListener('abort', fn);
}
