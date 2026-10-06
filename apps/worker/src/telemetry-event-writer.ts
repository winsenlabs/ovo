import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import {
  asError,
  boundedInteger,
  DEFAULT_CALL_EVENT_FLUSH_MS,
  DEFAULT_MAX_CALL_EVENTS,
  transient,
} from './telemetry-writer-support.ts';

export {
  boundedEvidenceText,
  boundedInteger,
  callEventWriterOptions,
  superviseTelemetry,
  telemetryError,
  voiceUsageUnit,
} from './telemetry-writer-support.ts';

const BATCH_SIZE = 50;
const CONCURRENT_CALLS = 4;
const RETRY_DELAYS_MS = [100, 400, 1_600];
const MAX_TRACKED_CALLS = 1_000;
/** An interim transcript revision is kept at most this often per call (OBS-10 sampling). */
const INTERIM_SAMPLE_MS = 250;
export interface CallEventInput {
  workspaceId: string;
  callId: string;
  type: string;
  payload: Record<string, unknown>;
  epoch?: number;
}

/** A store that can write several events of one call in one transaction writes them in batches. */
export type CallEventStore = Pick<ControlStore, 'appendCallEvent'> & {
  appendCallEvents?(
    workspaceId: string,
    callId: string,
    events: readonly { type: string; payload: Record<string, unknown>; epoch?: number }[],
  ): Promise<unknown>;
};

export interface CallEventWriterStats {
  accepted: number;
  written: number;
  /** Refused because the queue was full or closed, or still queued at the flush deadline. */
  dropped: number;
  /** Interim transcript revisions skipped by sampling or shed under queue pressure. */
  sampled: number;
  failed: number;
  retried: number;
  queued: number;
  closed: boolean;
}

/** One call's evidence accounting, written as its `telemetry.stats` event. */
export interface CallEventCounts {
  accepted: number;
  dropped: number;
  sampled: number;
  failed: number;
}

/**
 * Bounded, batched call evidence (OBS-10): audit failures never become business authority. Events
 * of one call are written in order, in batches, while up to four calls write at once; a transient
 * database failure is retried; interim transcripts are sampled; every loss is counted.
 */
export class BoundedCallEventWriter {
  private readonly queues = new Map<string, CallEventInput[]>();
  private readonly writing = new Set<string>();
  private readonly perCall = new Map<string, CallEventCounts & { interimAt: number }>();
  private readonly idle = new Set<() => void>();
  private queuedCount = 0;
  private inflight = 0;
  private closed = false;
  private readonly counters = {
    accepted: 0,
    written: 0,
    dropped: 0,
    sampled: 0,
    failed: 0,
    retried: 0,
  };

  constructor(
    private readonly store: CallEventStore,
    private readonly maxQueuedEvents = DEFAULT_MAX_CALL_EVENTS,
    private readonly flushTimeoutMs = DEFAULT_CALL_EVENT_FLUSH_MS,
    private readonly onError: (error: Error) => void = () => undefined,
  ) {
    boundedInteger(maxQueuedEvents, 1, 100_000, 'maxCallEvents');
    boundedInteger(flushTimeoutMs, 100, 60_000, 'callEventFlushTimeoutMs');
  }

  tryEnqueue(event: CallEventInput): boolean {
    const counts = this.countsFor(event);
    const pending = this.queuedCount + this.inflight;
    if (this.closed || pending >= this.maxQueuedEvents) {
      this.counters.dropped++;
      counts.dropped++;
      return false;
    }
    if (event.payload.isFinal === false && event.type === 'transcript.revision') {
      const now = Date.now();
      if (now - counts.interimAt < INTERIM_SAMPLE_MS || pending * 2 >= this.maxQueuedEvents) {
        this.counters.sampled++;
        counts.sampled++;
        return false;
      }
      counts.interimAt = now;
    }
    this.push(event);
    counts.accepted++;
    return true;
  }

  /**
   * Ends a call's accounting: queues its `telemetry.stats` event (never refused for capacity, one
   * per call) and returns the counts. Events still queued for the call are written as usual.
   */
  finishCall(workspaceId: string, callId: string): CallEventCounts {
    const key = `${workspaceId}\0${callId}`;
    const tracked = this.perCall.get(key);
    const counts: CallEventCounts = {
      accepted: tracked?.accepted ?? 0,
      dropped: tracked?.dropped ?? 0,
      sampled: tracked?.sampled ?? 0,
      failed: tracked?.failed ?? 0,
    };
    this.perCall.delete(key);
    if (!this.closed)
      this.push({ workspaceId, callId, type: 'telemetry.stats', payload: { ...counts } });
    return counts;
  }

  stats(): CallEventWriterStats {
    return { ...this.counters, queued: this.queuedCount + this.inflight, closed: this.closed };
  }

  /** Flush on shutdown: refuses new events and writes what is queued until the deadline. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.schedule();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.drained(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Call event flush deadline exceeded')),
            this.flushTimeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      this.counters.dropped += this.discardQueued();
      this.report(error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private push(event: CallEventInput): void {
    const key = `${event.workspaceId}\0${event.callId}`;
    const queue = this.queues.get(key) ?? [];
    queue.push(structuredClone(event));
    this.queues.set(key, queue);
    this.queuedCount++;
    this.counters.accepted++;
    this.schedule();
  }

  private countsFor(event: CallEventInput) {
    const key = `${event.workspaceId}\0${event.callId}`;
    let counts = this.perCall.get(key);
    if (!counts) {
      // Bounded even when a host never calls finishCall: the oldest call's counts go first.
      if (this.perCall.size >= MAX_TRACKED_CALLS)
        this.perCall.delete(this.perCall.keys().next().value!);
      counts = { accepted: 0, dropped: 0, sampled: 0, failed: 0, interimAt: 0 };
      this.perCall.set(key, counts);
    }
    return counts;
  }

  private discardQueued(): number {
    let discarded = 0;
    for (const [key, queue] of this.queues) {
      discarded += queue.splice(0).length;
      if (!this.writing.has(key)) this.queues.delete(key);
    }
    this.queuedCount -= discarded;
    return discarded;
  }

  private drained(): Promise<void> {
    if (!this.queuedCount && !this.inflight) return Promise.resolve();
    return new Promise((resolve) => this.idle.add(resolve));
  }

  private schedule(): void {
    for (const [key, queue] of this.queues) {
      if (this.writing.size >= CONCURRENT_CALLS) return;
      if (this.writing.has(key) || !queue.length) continue;
      this.writing.add(key);
      void this.drainCall(key)
        .catch((error) => this.report(error))
        .finally(() => {
          this.writing.delete(key);
          if (!this.queues.get(key)?.length) this.queues.delete(key);
          if (!this.queuedCount && !this.inflight) for (const resolve of this.idle) resolve();
          if (!this.queuedCount && !this.inflight) this.idle.clear();
          this.schedule();
        });
    }
  }

  private async drainCall(key: string): Promise<void> {
    for (let queue = this.queues.get(key); queue?.length; queue = this.queues.get(key)) {
      const batch = queue.splice(0, this.store.appendCallEvents ? BATCH_SIZE : 1);
      this.queuedCount -= batch.length;
      this.inflight += batch.length;
      try {
        await this.write(batch);
        this.counters.written += batch.length;
      } catch (error) {
        this.counters.failed += batch.length;
        const counts = this.perCall.get(key);
        if (counts) counts.failed += batch.length;
        this.report(error);
      } finally {
        this.inflight -= batch.length;
      }
    }
  }

  private async write(batch: CallEventInput[]): Promise<void> {
    const { workspaceId, callId } = batch[0]!;
    for (let attempt = 0; ; attempt++) {
      try {
        if (this.store.appendCallEvents)
          await this.store.appendCallEvents(
            workspaceId,
            callId,
            batch.map(({ type, payload, epoch }) => ({ type, payload, epoch })),
          );
        else
          for (const event of batch)
            await this.store.appendCallEvent(
              workspaceId,
              callId,
              event.type,
              event.payload,
              event.epoch,
            );
        return;
      } catch (error) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined || !transient(error)) throw error;
        this.counters.retried++;
        await new Promise((resolve) => setTimeout(resolve, delay).unref?.());
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
