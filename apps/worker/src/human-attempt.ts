import type { TransferTarget } from '@winsendotai/ovo-contracts';
import type { SegmentHistoryEntry } from './call-memory.ts';
import type {
  QueueSnapshot,
  Ticket,
  TicketContext,
  TicketOutcome,
  TicketReleaseCode,
} from './human-contract.ts';
import {
  humanCompleted,
  outcomeOfRelease,
  type HumanSource,
  type QueueRef,
} from './human-events.ts';
import { openTicket, releaseTicket } from './human-ticket.ts';
import type { HumanRuntime } from './human-runtime.ts';
import type { SegmentMediaLease } from './segment-media.ts';
import type { HumanTarget, StartableSegment, TransferAttempt } from './transfer-attempt.ts';

export interface HumanAttemptInit {
  runtime: HumanRuntime;
  index: number;
  lease: SegmentMediaLease;
  target: HumanTarget;
  queue: QueueSnapshot;
  source: HumanSource;
  /** The segment that asked, the catalogue target and the transferring side's words. */
  from: SegmentHistoryEntry;
  transfer?: number;
  catalogue?: TransferTarget;
  meta?: { summary?: string; reason?: string };
  /** How long the ticket may wait (the hold's `maxSeconds`). */
  waitSeconds: number;
}

/** A failed attempt's code and how it reads as a `human.completed` outcome. */
function failureOutcome(code: string): TicketOutcome {
  if (code === 'call_ended') return 'caller_hangup';
  if (code === 'webhook_rejected' || code.startsWith('destination_refused')) return 'rejected';
  if (code === 'webhook_failed' || code === 'queue_full' || code === 'ticket_create_failed')
    return 'unavailable';
  if (code === 'ticket_expired' || code === 'operator_no_show') return 'timeout';
  return 'failed';
}

/**
 * One human queue as the controller's next candidate (human queue design 7.1, 7.3). It is created
 * by `begin` without a ticket; `commit` (the requester starts announcing) creates the idempotent
 * ticket and runs the kind-specific work in the background; the controller waits on `settled`
 * exactly as for a composing graph. A candidate nobody takes is dropped: its ticket is released
 * with the code that says why, and whatever the kind opened (a seat, a room) is closed.
 */
export abstract class HumanAttempt implements TransferAttempt {
  settled?: StartableSegment | string;
  prepareMs?: number;
  readonly result: Promise<StartableSegment | string>;
  readonly done: Promise<void>;
  readonly index: number;
  readonly lease: SegmentMediaLease;
  readonly target: HumanTarget;
  protected readonly rt: HumanRuntime;
  protected readonly queue: QueueSnapshot;
  protected readonly stop = new AbortController();
  protected ticket?: Ticket;
  /** What the ticket was created with: the context and the idempotency key. */
  protected ticketContext!: TicketContext;
  protected idempotencyKey = '';
  protected startedAt = 0;
  /** When the attempt settled ready: the end of the caller's wait. */
  protected readyAt?: number;
  private state: 'idle' | 'running' | 'taken' | 'dropped' = 'idle';
  private settle!: (value: StartableSegment | string) => void;
  private finish!: () => void;
  private work?: Promise<void>;
  private completed = false;

  constructor(protected readonly init: HumanAttemptInit) {
    this.rt = init.runtime;
    this.index = init.index;
    this.lease = init.lease;
    this.target = init.target;
    this.queue = init.queue;
    this.result = new Promise((resolve) => (this.settle = resolve));
    this.done = new Promise((resolve) => (this.finish = resolve));
  }

  /** The runtime the attempt belongs to (its segment reads the call's ports from it). */
  get runtime(): HumanRuntime {
    return this.rt;
  }

  get ready(): boolean {
    return this.settled !== undefined && typeof this.settled !== 'string';
  }

  protected get ref(): QueueRef {
    return { key: this.queue.key, id: this.queue.id, kind: this.queue.definition.kind };
  }

  /** The kind's work once the ticket exists: a segment that is ready, or the code it failed with. */
  protected abstract run(signal: AbortSignal): Promise<StartableSegment | string>;
  /** What this kind opened that a candidate nobody took must close (cancel post, seat, room). */
  protected abstract cleanup(code: TicketReleaseCode): Promise<void>;

  commit(): void {
    if (this.state !== 'idle') return;
    this.state = 'running';
    this.startedAt = this.rt.deps.clock.now();
    this.work = this.begin().then((outcome) => {
      if (typeof outcome !== 'string') {
        this.readyAt = this.rt.deps.clock.now();
        this.prepareMs = this.readyAt - this.startedAt;
      }
      this.settled = outcome;
      this.settle(this.settled);
    });
    // swallow-ok: begin() reports its own failures as codes; this only closes `done`.
    void this.work.catch(() => undefined).finally(() => this.state !== 'dropped' && this.finish());
  }

  take(): StartableSegment | undefined {
    if (this.state !== 'running' || !this.ready) return undefined;
    this.state = 'taken';
    return this.settled as StartableSegment;
  }

  async drop(): Promise<void> {
    if (this.state === 'dropped' || this.state === 'taken') return;
    const began = this.state === 'running';
    // What the attempt had come to before it was given up on decides why it is released.
    const code = this.dropCode();
    const outcome = this.dropOutcome(code);
    this.state = 'dropped';
    this.stop.abort();
    if (!began) this.settle('call_ended');
    await this.work?.catch(() => undefined);
    // swallow-ok: a cleanup that cannot reach its store leaves the sweeper to expire the ticket.
    await this.dispose(code, outcome).catch(() => undefined);
    this.finish();
  }

  /**
   * Releases the ticket, closes what the kind opened and records how the attempt ended. Idempotent;
   * called by `drop` and by a segment that failed to start or was closed before it connected.
   */
  async dispose(code: TicketReleaseCode, outcome?: TicketOutcome): Promise<void> {
    if (this.completed) return;
    this.completed = true;
    await this.cleanup(code).catch(() => undefined);
    const ended = outcome ?? this.dropOutcome(code);
    await this.releaseTicket(code, ended);
    this.complete(ended, {});
  }

  /** The release code of a candidate that is dropped. */
  private dropCode(): TicketReleaseCode {
    if (this.rt.deps.ended().aborted) return 'call_ended';
    const settled = this.settled;
    if (typeof settled === 'string') {
      if (settled === 'webhook_rejected' || settled === 'webhook_failed') return settled;
      if (settled.startsWith('destination_refused')) return 'webhook_rejected';
    }
    return 'timed_out';
  }

  private dropOutcome(code: TicketReleaseCode): TicketOutcome {
    const settled = this.settled;
    if (typeof settled === 'string' && settled !== 'timeout') return failureOutcome(settled);
    return outcomeOfRelease(code);
  }

  /** A segment that connected has ended: releases the ticket with `code`, records the outcome. */
  async endConnected(
    code: TicketReleaseCode,
    outcome: TicketOutcome,
    extra: { talkMs?: number; operator?: string } = {},
  ): Promise<void> {
    if (this.completed) return;
    this.completed = true;
    await this.releaseTicket(code, outcome);
    this.complete(outcome, extra);
  }

  /** Records `human.completed` once. */
  private complete(outcome: TicketOutcome, extra: { talkMs?: number; operator?: string }): void {
    if (!this.ticket) return;
    const { clock } = this.rt.deps;
    this.rt.deps.record(
      'human.completed',
      humanCompleted(this.ref, {
        ticket: this.ticket.id,
        outcome,
        waitMs: (this.readyAt ?? clock.now()) - this.startedAt,
        segment: this.index,
        ...extra,
      }),
    );
    this.rt.deps.log('human_completed', {
      jobId: this.rt.deps.call.jobId,
      queue: this.queue.key,
      outcome,
    });
  }

  /** Releases the ticket with `code`; a conflict means someone else already did. */
  private releaseTicket(code: TicketReleaseCode, outcome: TicketOutcome): Promise<void> {
    return this.ticket ? releaseTicket(this.rt, this.ticket.id, code, outcome) : Promise.resolve();
  }

  private async begin(): Promise<StartableSegment | string> {
    const outcome = await this.open();
    if (typeof outcome === 'string')
      this.rt.deps.log('human_failed', {
        jobId: this.rt.deps.call.jobId,
        queue: this.queue.key,
        code: outcome,
      });
    return outcome;
  }

  private async open(): Promise<StartableSegment | string> {
    try {
      const created = await openTicket(this.rt, this.init, this.ref);
      if (typeof created === 'string') return created;
      this.ticket = created.ticket;
      this.ticketContext = created.context;
      this.idempotencyKey = created.idempotencyKey;
      return await this.run(this.stop.signal);
    } catch {
      // swallow-ok: a failure of the kind's work is a code the chain acts on, not a crash.
      return this.rt.deps.ended().aborted || this.stop.signal.aborted
        ? 'call_ended'
        : 'compose_failed';
    }
  }
}

/** A human segment's `release`: the queue stands where an agent's release would (design 7.1). */
export function humanRelease(
  queue: Pick<QueueSnapshot, 'id' | 'key'>,
  language: string,
): StartableSegment['release'] {
  return { id: queue.id, agentId: `queue:${queue.key}`, config: { language } };
}
