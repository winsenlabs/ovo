import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { readSessionEvent, type EventSink } from '@winsendotai/ovo-contracts';
import type { CallOutcomeStore, SessionEventInput } from './store.ts';
import { SESSION_EVENT_BATCH_MAX } from './postgres-store.ts';

export interface SessionEventSinkOptions {
  /** Events waiting or being written at once; past this an append is dropped and counted. */
  maxQueued?: number;
  /** Longest `flush()` waits before dropping what is left. */
  flushTimeoutMs?: number;
  /** Attempts per batch before it is dropped; a stored id makes a retry idempotent. */
  attempts?: number;
  retryDelayMs?: number;
  onError?: (error: Error) => void;
  now?: () => Date;
}

export interface SessionEventSinkStats {
  accepted: number;
  written: number;
  rejected: number;
  dropped: number;
  failedWrites: number;
  queued: number;
}

/**
 * The `EventSink` a live session holds (AGT-8). `append` validates and queues synchronously and
 * never throws, so recording an outcome cannot slow or fail a turn. Writes run one batch at a time
 * on a single promise chain, so events keep their order. A storage outage loses events after
 * `attempts`, never the call.
 */
export class QueuedSessionEventSink implements EventSink {
  private pending: SessionEventInput[] = [];
  private writing = 0;
  private tail: Promise<void> = Promise.resolve();
  private sealed = false;
  private readonly stat = { accepted: 0, written: 0, rejected: 0, dropped: 0, failedWrites: 0 };

  constructor(
    private readonly store: Pick<CallOutcomeStore, 'append'>,
    private readonly identity: { workspaceId: string; callId: string },
    private readonly options: SessionEventSinkOptions = {},
  ) {}

  async append(type: string, payload: Record<string, unknown>): Promise<void> {
    let event;
    try {
      event = readSessionEvent(type, payload);
    } catch (error) {
      this.stat.rejected += 1;
      this.warn(error);
      return;
    }
    const capacity = this.options.maxQueued ?? 1_000;
    if (this.sealed || this.pending.length + this.writing >= capacity) {
      this.stat.dropped += 1;
      return;
    }
    const at = (this.options.now?.() ?? new Date()).toISOString();
    this.pending.push({ id: randomUUID(), at, type: event.type, payload: event.payload });
    this.stat.accepted += 1;
    // One link per append: each link writes whatever is pending by then, so a burst is one batch.
    this.tail = this.tail.then(() => this.writePending());
  }

  /** Stops accepting events and writes what is queued, up to `flushTimeoutMs`. */
  async flush(): Promise<void> {
    this.sealed = true;
    const deadline = AbortSignal.timeout(this.options.flushTimeoutMs ?? 5_000);
    const expired = new Promise<'expired'>((resolve) =>
      deadline.addEventListener('abort', () => resolve('expired'), { once: true }),
    );
    if ((await Promise.race([this.tail, expired])) !== 'expired') return;
    this.stat.dropped += this.pending.length;
    this.pending = [];
    this.warn(new Error('Session event flush deadline exceeded'));
  }

  stats(): SessionEventSinkStats {
    return { ...this.stat, queued: this.pending.length + this.writing };
  }

  private async writePending(): Promise<void> {
    while (this.pending.length) {
      const batch = this.pending.splice(0, SESSION_EVENT_BATCH_MAX);
      this.writing = batch.length;
      try {
        await this.withRetries(batch);
        this.stat.written += batch.length;
      } catch (error) {
        this.stat.dropped += batch.length;
        this.warn(error);
      } finally {
        this.writing = 0;
      }
    }
  }

  private async withRetries(batch: readonly SessionEventInput[]): Promise<void> {
    const attempts = Math.max(1, this.options.attempts ?? 3);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.store
          .append(this.identity.workspaceId, this.identity.callId, batch)
          .then(() => undefined);
      } catch (error) {
        this.stat.failedWrites += 1;
        if (attempt === attempts) throw error;
        this.warn(error);
        await sleep((this.options.retryDelayMs ?? 250) * attempt);
      }
    }
  }

  private warn(error: unknown): void {
    const report = this.options.onError;
    if (!report) return;
    try {
      report(error instanceof Error ? error : new Error(String(error)));
    } catch (failure) {
      // swallow-ok: a failing reporter must not break the call; the event is already counted.
      void failure;
    }
  }
}
