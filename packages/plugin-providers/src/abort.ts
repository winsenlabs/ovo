export interface OperationSignal {
  signal: AbortSignal;
  dispose(): void;
}

export function withDeadline(
  caller: AbortSignal,
  timeoutMs: number,
  message: string,
): OperationSignal {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new TypeError('timeoutMs must be a positive integer');
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(caller.reason);
  if (caller.aborted) abortFromCaller();
  else caller.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException(message, 'TimeoutError')),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      caller.removeEventListener('abort', abortFromCaller);
    },
  };
}

export function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Provider operation cancelled', 'AbortError');
}

export function decimal(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new TypeError('Usage value must be nonnegative');
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}
