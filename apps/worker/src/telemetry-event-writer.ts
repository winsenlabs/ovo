import type { ControlStore } from '@winsendotai/ovo-plugin-storage';

const DEFAULT_MAX_CALL_EVENTS = 1_000;
const DEFAULT_CALL_EVENT_FLUSH_MS = 5_000;

export interface CallEventInput {
  workspaceId: string;
  callId: string;
  type: string;
  payload: Record<string, unknown>;
  epoch?: number;
}

export interface CallEventWriterStats {
  accepted: number;
  written: number;
  dropped: number;
  failed: number;
  queued: number;
  closed: boolean;
}

/** One bounded promise chain: audit failures never become business authority. */
export class BoundedCallEventWriter {
  private readonly queue: CallEventInput[] = [];
  private draining?: Promise<void>;
  private inflight = 0;
  private closed = false;
  private readonly counters = { accepted: 0, written: 0, dropped: 0, failed: 0 };

  constructor(
    private readonly store: Pick<ControlStore, 'appendCallEvent'>,
    private readonly maxQueuedEvents = DEFAULT_MAX_CALL_EVENTS,
    private readonly flushTimeoutMs = DEFAULT_CALL_EVENT_FLUSH_MS,
    private readonly onError: (error: Error) => void = () => undefined,
  ) {
    boundedInteger(maxQueuedEvents, 1, 100_000, 'maxCallEvents');
    boundedInteger(flushTimeoutMs, 100, 60_000, 'callEventFlushTimeoutMs');
  }

  tryEnqueue(event: CallEventInput): boolean {
    if (this.closed || this.queue.length + this.inflight >= this.maxQueuedEvents) {
      this.counters.dropped++;
      return false;
    }
    this.queue.push(structuredClone(event));
    this.counters.accepted++;
    this.schedule();
    return true;
  }

  stats(): CallEventWriterStats {
    return {
      ...this.counters,
      queued: this.queue.length + this.inflight,
      closed: this.closed,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.schedule();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.draining ?? Promise.resolve(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Call event flush deadline exceeded')),
            this.flushTimeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      this.counters.dropped += this.queue.splice(0).length;
      this.report(error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private schedule(): void {
    if (this.draining || !this.queue.length) return;
    this.draining = this.drain()
      .catch((error) => this.report(error))
      .finally(() => {
        this.draining = undefined;
        if (this.queue.length) this.schedule();
      });
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const event = this.queue.shift()!;
      this.inflight = 1;
      try {
        await this.store.appendCallEvent(
          event.workspaceId,
          event.callId,
          event.type,
          event.payload,
          event.epoch,
        );
        this.counters.written++;
      } catch (error) {
        this.counters.failed++;
        this.report(error);
      } finally {
        this.inflight = 0;
      }
    }
  }

  private report(error: unknown): void {
    try {
      this.onError(asError(error));
    } catch {
      // Error reporting must not create another unhandled failure.
    }
  }
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
  const safe = text.replaceAll('\0', '\uFFFD');
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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
