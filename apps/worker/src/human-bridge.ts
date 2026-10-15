import { CAPTION_TOPIC, DTMF_TOPIC } from '@winsendotai/ovo-contracts';
import { BridgeAudio } from './human-bridge-audio.ts';
import { BEAT_MS, endOf, OPERATOR_GRACE_MS, type End } from './human-bridge-end.ts';
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
import { HumanTranscriber } from './human-transcriber.ts';
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
  private connectedAt = 0;

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
      this.lease.onClose((reason) => void this.close(reason)),
    );
    if (this.def.ai.mode === 'transcribe' && deps.openStt && deps.transcript)
      this.transcriber = await HumanTranscriber.open({
        open: deps.openStt,
        usage: deps.usageFor(this.input.index),
        format: deps.format,
        language: deps.sttLanguage,
        sessionId: deps.call.sessionId,
        idPrefix: `s${this.input.index}:`,
        operator: this.def.ai.transcribeOperator,
        caption: (caption) =>
          this.seat.sendData(CAPTION_TOPIC, new TextEncoder().encode(JSON.stringify(caption)), [
            this.operator,
          ]),
        transcript: (event) => deps.transcript!(event, this.input.index),
        now: () => this.clock.now(),
        failed: (reason) => deps.audit('human.transcribe.failed', { reason }),
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
    void this.watch();
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
    const talkMs = Math.max(0, this.clock.now() - this.connectedAt);
    const seatStats = this.seat.stats();
    await this.transcriber?.close().catch(() => undefined);
    await this.seat.close().catch(() => undefined);
    await deps.rooms?.deleteRoom(this.input.room).catch(() => undefined);
    this.stats.usage[HUMAN_METER_KEYS.operatorSeconds] = talkMs / 1000;
    this.stats.usage[HUMAN_METER_KEYS.roomSeconds] = seatStats.connectedMs / 1000;
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
    void this.clock
      .sleep(OPERATOR_GRACE_MS, AbortSignal.any([grace.signal, this.stop.signal]))
      .then(() => {
        if (!grace.signal.aborted && !this.stop.signal.aborted) void this.operatorLeft();
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
    await this.rt.deps.endCall(this.lease, 'behavior_completed');
  }

  /** Beat, then poll the ticket for a command or an end someone else wrote. */
  private async watch(): Promise<void> {
    const { deps } = this.rt;
    const id = this.input.ticket.id;
    let beat = this.clock.now();
    while (!this.closed) {
      await this.clock.sleep(deps.pollMs, this.stop.signal);
      if (this.closed) return;
      if (this.clock.now() - beat >= BEAT_MS) {
        beat = this.clock.now();
        // swallow-ok: a missed beat is retried in five seconds; the sweeper allows twenty.
        void deps.service.tickets.workerBeat(id).catch(() => undefined);
      }
      const ticket = await deps.service.tickets.get(id).catch(() => undefined);
      if (!ticket || this.closed) continue;
      // Released under the call (an admin): it ends as if the operator left.
      if (ticket.status === 'released' || ticket.status === 'expired')
        return void this.hangUp({ code: 'operator_left', outcome: 'ended' });
      const command = ticket.command;
      if (command && command.seq > command.ack) await this.execute(id, command.seq, command.body);
    }
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
    const result = await deps.returnToAgent({
      key,
      from,
      lease: this.lease,
      signal: this.stop.signal,
    });
    if (result.ok) return true;
    this.end = undefined;
    deps.audit('human.return.refused', { reason: result.reason });
    return false;
  }
}
