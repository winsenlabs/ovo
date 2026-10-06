/** Writer configuration, evidence text bounds and supervision shared by the telemetry modules. */
export const DEFAULT_MAX_CALL_EVENTS = 1_000;
export const DEFAULT_CALL_EVENT_FLUSH_MS = 5_000;

/** Connection loss, pool exhaustion, serialization and deadlock: worth another attempt. */
const TRANSIENT_CODES = new Set([
  '40001',
  '40P01',
  '53300',
  '57P01',
  '57P03',
  '08000',
  '08001',
  '08003',
  '08006',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
]);

export function transient(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && TRANSIENT_CODES.has(code);
}

export function callEventWriterOptions(options: {
  maxCallEvents?: number;
  callEventFlushTimeoutMs?: number;
}): { maxQueuedEvents: number; flushTimeoutMs: number } {
  return {
    maxQueuedEvents: options.maxCallEvents ?? DEFAULT_MAX_CALL_EVENTS,
    flushTimeoutMs: options.callEventFlushTimeoutMs ?? DEFAULT_CALL_EVENT_FLUSH_MS,
  };
}

export function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
}

export function boundedEvidenceText(
  text: string,
  maximum: number,
): { value: string; truncated: boolean } {
  const safe = text.replaceAll('\0', '�');
  if (safe.length <= maximum) return { value: safe, truncated: false };
  return { value: safe.slice(0, maximum), truncated: true };
}

export function voiceUsageUnit(
  unit: string,
): 'audio_seconds' | 'characters' | 'tokens' | undefined {
  if (unit === 'audio_seconds' || unit === 'characters' || unit === 'tokens') return unit;
  return undefined;
}

export async function superviseTelemetry(
  work: () => Promise<void>,
  report: (error: Error) => void,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    try {
      report(asError(error));
    } catch {
      // Shutdown remains bounded even if the reporter fails.
    }
  }
}

export function telemetryError(error: unknown): Error {
  return asError(error);
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
