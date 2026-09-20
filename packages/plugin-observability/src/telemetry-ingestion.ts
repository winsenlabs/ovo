import type {
  PerformanceQuery,
  TelemetryEvent,
  TelemetryIngestionStats,
  TelemetryRepository,
} from './telemetry-types.ts';

export interface BufferedTelemetryOptions {
  maxQueuedEvents?: number;
  maxBatchSize?: number;
  flushTimeoutMs?: number;
  retentionDays?: number;
  pruneEveryBatches?: number;
  pruneBatchSize?: number;
}

export class BufferedTelemetryWriter {
  private readonly queue: TelemetryEvent[] = [];
  private readonly counters: TelemetryIngestionStats = {
    accepted: 0,
    inserted: 0,
    duplicates: 0,
    conflicts: 0,
    dropped: 0,
    failedBatches: 0,
    failedEvents: 0,
    queued: 0,
    closed: false,
  };
  private draining?: Promise<void>;
  private batches = 0;
  private inflight = 0;
  private readonly maxQueuedEvents: number;
  private readonly maxBatchSize: number;
  private readonly flushTimeoutMs: number;
  private readonly retentionDays: number;
  private readonly pruneEveryBatches: number;
  private readonly pruneBatchSize: number;

  constructor(
    private readonly repository: TelemetryRepository,
    options: BufferedTelemetryOptions = {},
  ) {
    this.maxQueuedEvents = bound(options.maxQueuedEvents ?? 2_000, 1, 100_000);
    this.maxBatchSize = bound(options.maxBatchSize ?? 50, 1, 100);
    this.flushTimeoutMs = bound(options.flushTimeoutMs ?? 5_000, 100, 60_000);
    this.retentionDays = bound(options.retentionDays ?? 30, 1, 365);
    this.pruneEveryBatches = bound(options.pruneEveryBatches ?? 100, 1, 10_000);
    this.pruneBatchSize = bound(options.pruneBatchSize ?? 1_000, 1, 10_000);
  }

  /** Never waits for PostgreSQL. False means the event was explicitly dropped. */
  tryEnqueue(event: TelemetryEvent): boolean {
    if (this.counters.closed || this.queue.length + this.inflight >= this.maxQueuedEvents) {
      this.counters.dropped++;
      return false;
    }
    this.queue.push(event);
    this.counters.accepted++;
    this.counters.queued = this.queue.length + this.inflight;
    this.schedule();
    return true;
  }

  stats(): TelemetryIngestionStats {
    return { ...this.counters, queued: this.queue.length + this.inflight };
  }

  ingestionStats(): TelemetryIngestionStats {
    return this.stats();
  }

  queryPerformance(workspaceId: string, query: PerformanceQuery) {
    return this.repository.queryPerformance(workspaceId, query);
  }

  listCallEvents(workspaceId: string, callId: string, afterSequence: number, limit?: number) {
    return this.repository.listCallEvents(workspaceId, callId, afterSequence, limit);
  }

  async flush(timeoutMs = this.flushTimeoutMs): Promise<void> {
    this.schedule();
    const work = this.draining ?? Promise.resolve();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Telemetry flush deadline exceeded')),
            timeoutMs,
          );
        }),
      ]);
    } catch (error) {
      const abandoned = this.queue.splice(0).length;
      this.counters.dropped += abandoned;
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      this.counters.queued = this.queue.length + this.inflight;
    }
  }

  async close(timeoutMs = this.flushTimeoutMs): Promise<void> {
    this.counters.closed = true;
    await this.flush(timeoutMs);
  }

  private schedule(): void {
    if (this.draining || !this.queue.length) return;
    this.draining = Promise.resolve()
      .then(() => this.drain())
      .finally(() => {
        this.draining = undefined;
        if (this.queue.length) this.schedule();
      });
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const batch = this.queue.splice(0, this.maxBatchSize);
      this.inflight = batch.length;
      this.counters.queued = this.queue.length + this.inflight;
      try {
        const result = await this.repository.ingest(batch);
        this.counters.inserted += result.inserted;
        this.counters.duplicates += result.duplicates;
        this.counters.conflicts += result.conflicts;
      } catch {
        this.counters.failedBatches++;
        this.counters.failedEvents += batch.length;
      } finally {
        this.inflight = 0;
        this.counters.queued = this.queue.length;
      }
      this.batches++;
      if (this.batches % this.pruneEveryBatches === 0) await this.prune();
    }
  }

  private async prune(): Promise<void> {
    const before = new Date(Date.now() - this.retentionDays * 86_400_000).toISOString();
    try {
      await this.repository.prune(before, this.pruneBatchSize);
    } catch {
      this.counters.failedBatches++;
    }
  }
}

function bound(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`Expected integer from ${minimum} to ${maximum}`);
  return value;
}
