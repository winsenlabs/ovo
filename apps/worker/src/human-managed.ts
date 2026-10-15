import {
  CALLER_IDENTITY,
  type ManagedQueue,
  type RoomSeat,
  type Ticket,
  type TicketReleaseCode,
} from './human-contract.ts';
import { HumanAttempt, type HumanAttemptInit } from './human-attempt.ts';
import { isTicket } from './human-ticket.ts';
import { HumanBridgeSegment } from './human-bridge.ts';
import { humanState } from './human-events.ts';
import type { StartableSegment } from './transfer-attempt.ts';

const BEAT_MS = 5_000;
const JOIN_TRIES = 2;

/**
 * An OVO-managed queue (design 7.5): the ticket waits for an operator; once one accepts, the
 * worker joins the room as the caller's seat and waits for the operator to arrive. An operator who
 * never joins within `joinSeconds` is released back to the queue (`operator_no_show`) and the
 * caller keeps holding. Ready is an accepted ticket with the operator in the room.
 */
export class HumanManagedAttempt extends HumanAttempt {
  private seat?: RoomSeat;
  private room?: string;

  constructor(init: HumanAttemptInit) {
    super(init);
  }

  private get def(): ManagedQueue {
    return this.queue.definition as ManagedQueue;
  }

  protected async run(signal: AbortSignal): Promise<StartableSegment | string> {
    const { deps } = this.rt;
    const id = this.ticket!.id;
    let lastBeat = deps.clock.now();
    let acceptedAt: number | undefined;
    let joinFailures = 0;
    for (;;) {
      await deps.clock.sleep(deps.pollMs, signal);
      if (signal.aborted) return 'call_ended';
      if (deps.clock.now() - lastBeat >= BEAT_MS) {
        lastBeat = deps.clock.now();
        // swallow-ok: a missed beat is retried in five seconds; the sweeper allows twenty.
        void deps.service.tickets.workerBeat(id).catch(() => undefined);
      }
      const ticket = await deps.service.tickets.get(id).catch(() => undefined);
      if (!ticket) continue;
      this.ticket = ticket;
      if (ticket.status === 'released' || ticket.status === 'expired')
        return ticket.status === 'released' && ticket.releaseCode === 'operator_left'
          ? 'operator_left'
          : 'ticket_expired';
      if (ticket.status !== 'accepted' || !ticket.roomName) {
        // Offered or waiting again (declined, expired offer, re-offered): no seat is held.
        if (this.seat) await this.closeSeat();
        acceptedAt = undefined;
        continue;
      }
      acceptedAt ??= deps.clock.now();
      if (!this.seat && !(await this.join(ticket, signal))) {
        joinFailures += 1;
        if (joinFailures < JOIN_TRIES) continue;
        deps.shared.breaker(this.queue.id).failure();
        await this.reoffer(ticket);
        joinFailures = 0;
        acceptedAt = undefined;
        continue;
      }
      if (this.seat?.operatorPresent())
        return new HumanBridgeSegment(this, {
          seat: this.seat,
          ticket,
          room: this.room!,
          queue: this.queue,
          index: this.index,
          lease: this.lease,
        });
      if (deps.clock.now() - acceptedAt > this.def.joinSeconds * 1000) {
        await this.reoffer(ticket);
        acceptedAt = undefined;
      }
    }
  }

  private async join(ticket: Ticket, signal: AbortSignal): Promise<boolean> {
    const { deps } = this.rt;
    try {
      this.seat = await deps.rooms!.join({
        room: ticket.roomName!,
        identity: CALLER_IDENTITY,
        format: deps.format,
        signal,
      });
      this.room = ticket.roomName!;
      return true;
    } catch {
      // swallow-ok: a join that fails is retried once, then the ticket goes back to the queue.
      deps.audit('human.room.failed', { queue: this.queue.key });
      return false;
    }
  }

  /** The operator did not come: the seat goes, the ticket is offered again, the hold plays on. */
  private async reoffer(ticket: Ticket): Promise<void> {
    const { deps } = this.rt;
    await this.closeSeat();
    const again = await deps.service.tickets
      .reoffer(ticket.id, ticket.version, 'operator_no_show')
      .catch(() => undefined);
    if (again && isTicket(again))
      deps.record(
        'human.state',
        humanState(ticket.id, 'waiting', {
          by: 'worker',
          code: 'operator_no_show',
          version: again.version,
        }),
      );
  }

  private async closeSeat(): Promise<void> {
    const seat = this.seat;
    this.seat = undefined;
    await seat?.close().catch(() => undefined);
  }

  /** The room this attempt's bridge is leaving, deleted when it never connected. */
  protected async cleanup(_code: TicketReleaseCode): Promise<void> {
    await this.closeSeat();
    if (this.room) await this.rt.deps.rooms?.deleteRoom(this.room).catch(() => undefined);
  }
}
