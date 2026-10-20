import { DTMF_TOPIC } from '@winsendotai/ovo-contracts';
import { BridgeAudio } from './human-bridge-audio.ts';
import { endOf, OPERATOR_GRACE_MS, type End } from './human-bridge-end.ts';
import { watchTicket } from './human-bridge-watch.ts';
import { humanRelease } from './human-attempt.ts';
import type { HumanManagedAttempt } from './human-managed.ts';
import {
  CALLER_IDENTITY,
  HUMAN_METER_KEYS,
  type DeskCommand,
  type ManagedQueue,
  type QueueSnapshot,
  type RoomSeat,
  type Ticket,
  type TicketOutcome,
  type TicketReleaseCode,
} from './human-contract.ts';
import { openCaptions } from './human-captions.ts';
import type { HumanTranscriber } from './human-transcriber.ts';
import type { SegmentMediaLease } from './segment-media.ts';
import { SegmentStats } from './segment-telemetry.ts';
import type { StartableSegment } from './transfer-attempt.ts';
import { humanState } from './human-events.ts';
import type { HoldClock } from './hold-player.ts';

interface BridgeInput {
  seat: RoomSeat;
  ticket: Ticket;
  room: string;
  queue: QueueSnapshot;
  index: number;
  lease: SegmentMediaLease;
}

/**
 * The human segment of a managed queue (human queue design 7.5): a bridge between the call's lease
 * and the room the operator is in. The caller's audio goes to the room as 20 ms frames, the
 * operator's comes back through a bounded queue (the oldest frames are dropped and counted when
 * the carrier falls behind; the link is never cleared). The ticket carries the control plane:
 * commands the operator issued through the API are executed here, the worker's beat tells the
 * store the call is alive, and the operator dropping out gets a short grace before the queue's
 * `onOperatorLeave` applies. Closing is idempotent and always releases the ticket, the seat and the
 * room, and reports the segment's operator and room seconds.
 */
export class HumanBridgeSegment implements StartableSegment {
  readonly kind = 'human';
  readonly release: StartableSegment['release'];
  readonly stats: SegmentStats;
  readonly entryInfo: NonNullable<StartableSegment['entryInfo']>;
  ending?: 'operator_end';
  private readonly rt;
  private readonly def: ManagedQueue;
  private readonly seat: RoomSeat;
  private readonly lease: SegmentMediaLease;
  private readonly operator: string;
  private readonly audio: BridgeAudio;
  private readonly stop = new AbortController();
  private readonly offs: (() => void)[] = [];
  private transcriber?: HumanTranscriber;
  private closed = false;
  private closing?: Promise<undefined>;
  private end?: End;
  private grace?: AbortController;
  private connectedAt?: number;

  constructor(
    private readonly attempt: HumanManagedAttempt,
    private readonly input: BridgeInput,
  ) {
    this.rt = attempt.runtime;
    this.def = input.queue.definition as ManagedQueue;
    this.seat = input.seat;
    this.lease = input.lease;
    this.operator = `op:${input.ticket.assignedOperatorId ?? ''}`;
    const language = this.rt.deps.memory.route?.language ?? 'en';
    this.release = humanRelease(input.queue, language);
    this.stats = new SegmentStats(input.index, language);
    this.entryInfo = {
      ticketId: input.ticket.id,
      queueKind: 'managed',
      ...(input.ticket.assignedOperatorId ? { operatorId: input.ticket.assignedOperatorId } : {}),
    };
    this.audio = new BridgeAudio({
      seat: input.seat,
      lease: input.lease,
      format: this.rt.deps.format,
      clock: this.rt.deps.clock,
      stop: this.stop.signal,
      heard: (side, frame) =>
        side === 'caller'
          ? this.transcriber?.callerAudio(frame)
          : this.transcriber?.operatorAudio(frame),
    });
  }

  private get clock(): HoldClock {
    return this.rt.deps.clock;
  }

  /** Wires the audio both ways and opens the captions; the loops begin once attached. */
  async start(): Promise<void> {
    const { deps } = this.rt;
    this.connectedAt = this.clock.now();
    this.offs.push(
      this.lease.onAudio((bytes) => this.audio.fromCaller(bytes)),
      this.lease.onDtmf((digit) => this.sendDtmf(digit)),
      this.seat.onOperatorAudio((frame) => this.audio.toCaller(frame)),
      this.seat.onParticipant((event) => this.onParticipant(event)),
      // The caller (or the carrier) hung up: the operator is let go at once, not at call cleanup.
      this.lease.onClose((reason) => this.detach('close', this.close(reason))),
    );
    if (this.def.ai.mode === 'transcribe')
      this.transcriber = await openCaptions({
        deps,
        seat: this.seat,
        operatorIdentity: this.operator,
        operator: this.def.ai.transcribeOperator,
        index: this.input.index,
        now: () => this.clock.now(),
      });
    deps.record(
      'human.state',
      humanState(this.input.ticket.id, 'connected', {
        by: 'worker',
        operator: this.input.ticket.assignedOperatorId ?? '',
      }),
    );
    deps.log('human_connected', { jobId: deps.call.jobId, queue: this.input.queue.key });
  }

  /** The lease is live and `route.segment` recorded: operator audio may flow, the loops begin. */
  attached(): void {
    this.audio.attach();
    // swallow-ok: the desk shows the call connected; a missed mark is cosmetic.
    void this.rt.deps.service.tickets.markConnected(this.input.ticket.id).catch(() => undefined);
    this.detach('watch', this.watch());
  }

  /** Idempotent: a second close (the call's cleanup after the caller's hang-up) awaits the first. */
  close(reason: string): Promise<undefined> {
    return (this.closing ??= this.shutdown(reason));
  }

  private async shutdown(reason: string): Promise<undefined> {
    this.closed = true;
    this.stop.abort();
    this.audio.close();
    this.grace?.abort();
    for (const off of this.offs.splice(0)) off();
    const { deps } = this.rt;
    const talkMs = this.connectedAt === undefined ? 0 : this.clock.now() - this.connectedAt;
    const seatStats = this.seat.stats();
    await this.transcriber?.close().catch(() => undefined);
    await this.seat.close().catch(() => undefined);
    await deps.rooms?.deleteRoom(this.input.room).catch(() => undefined);
    // Closed before `start()` ran (the call ended first): no operator or room time to meter.
    if (this.connectedAt !== undefined) {
      this.stats.usage[HUMAN_METER_KEYS.operatorSeconds] = Math.max(0, talkMs) / 1000;
      this.stats.usage[HUMAN_METER_KEYS.roomSeconds] = seatStats.connectedMs / 1000;
    }
    const end = this.end ?? endOf(reason);
    await this.attempt.endConnected(end.code, end.outcome, {
      talkMs,
      ...(this.input.ticket.assignedOperatorId
        ? { operator: this.input.ticket.assignedOperatorId }
        : {}),
    });
    deps.log('human_bridge_closed', {
      jobId: deps.call.jobId,
      queue: this.input.queue.key,
      framesIn: seatStats.framesIn,
      framesOut: seatStats.framesOut,
      droppedIn: seatStats.droppedIn,
      droppedOut: seatStats.droppedOut + this.audio.dropped,
    });
    return undefined;
  }

  private sendDtmf(digit: string): void {
    if (this.closed) return;
    this.seat.sendData(DTMF_TOPIC, new TextEncoder().encode(JSON.stringify({ digit })), [
      this.operator,
    ]);
  }

  private onParticipant(event: { kind: 'joined' | 'left'; identity: string }): void {
    if (this.closed || event.identity === CALLER_IDENTITY || event.identity !== this.operator)
      return;
    if (event.kind === 'joined') return void this.grace?.abort();
    this.grace?.abort();
    const grace = (this.grace = new AbortController());
    const waited = this.clock
      .sleep(OPERATOR_GRACE_MS, AbortSignal.any([grace.signal, this.stop.signal]))
      .then(() => {
        if (!grace.signal.aborted && !this.stop.signal.aborted) return this.operatorLeft();
      });
    this.detach('operator_left', waited);
  }

  /**
   * Detached work (the watch loop, the grace, the lease's close) must never reject: an unhandled
   * rejection would take the whole worker, and every other call on it, down. A failure is audited
   * (never its message, which may carry carrier detail) and the segment closes.
   */
  private detach(where: string, work: Promise<unknown>): void {
    void work.catch(() => {
      this.rt.deps.audit('human.end.failed', { where });
      this.close('error:end_failed').catch(() => undefined);
    });
  }

  /** The operator did not come back: the queue's `onOperatorLeave` decides what the caller gets. */
  private async operatorLeft(): Promise<void> {
    const target = this.def.returnDefault;
    if (this.def.onOperatorLeave === 'return_to_agent' && target) {
      const code = { code: 'operator_left', outcome: 'returned' } as const;
      if (await this.returnTo(target, code)) return;
    }
    await this.hangUp({ code: 'operator_left', outcome: 'ended' });
  }

  /** No engine ends a person's call: the hang-up, then the lease. */
  private async hangUp(end: End): Promise<void> {
    this.end = end;
    try {
      await this.rt.deps.endCall(this.lease, 'behavior_completed');
    } catch {
      // The carrier refused to hang up: the operator is still let go and the ticket released.
      this.rt.deps.audit('human.end.failed', { where: 'hang_up' });
      await this.close('error:end_failed');
    }
  }

  private watch(): Promise<void> {
    return watchTicket({
      deps: this.rt.deps,
      ticketId: this.input.ticket.id,
      stop: this.stop.signal,
      closed: () => this.closed,
      // Released under the call (an admin): it ends as if the operator left.
      ended: () => this.hangUp({ code: 'operator_left', outcome: 'ended' }),
      command: (seq, command) => this.execute(this.input.ticket.id, seq, command),
    });
  }

  private async execute(id: string, seq: number, command: DeskCommand): Promise<void> {
    const { deps } = this.rt;
    await deps.service.tickets.ackCommand(id, seq).catch(() => undefined);
    if (command.kind === 'end_call') {
      this.ending = 'operator_end';
      return this.hangUp({ code: 'ended_by_operator', outcome: 'ended', ending: 'operator_end' });
    }
    if (!this.def.returnTargets.includes(command.target)) {
      deps.audit('human.command.refused', { reason: 'target_not_granted' });
      return;
    }
    await this.returnTo(command.target, { code: 'returned', outcome: 'returned' });
  }

  /** Sends the caller back to an agent; false (the operator stays) when the controller refuses. */
  private async returnTo(
    key: string,
    end: { code: TicketReleaseCode; outcome: TicketOutcome },
  ): Promise<boolean> {
    const { deps } = this.rt;
    const from = deps.attachedEntry();
    if (!deps.returnToAgent || !from) return false;
    this.end = end;
    const result = await deps
      .returnToAgent({ key, from, lease: this.lease, signal: this.stop.signal })
      .catch(() => ({ ok: false as const, reason: 'error' }));
    if (result.ok) return true;
    this.end = undefined;
    deps.audit('human.return.refused', { reason: result.reason });
    return false;
  }
}
