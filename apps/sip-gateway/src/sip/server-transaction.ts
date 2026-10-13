import { TimerSet, reliable, type Flow, type TransactionContext } from './flow.ts';
import type { SipRequest, SipResponse } from './message.ts';

export type ServerState =
  'trying' | 'proceeding' | 'completed' | 'confirmed' | 'accepted' | 'terminated';

/**
 * RFC 3261 §17.2 server transactions, with the RFC 6026 "Accepted" state for INVITE 2xx: the
 * transaction absorbs INVITE retransmissions for Timer L while the TU retransmits the 2xx.
 */
export class ServerTransaction {
  state: ServerState;
  private last?: SipResponse;
  private readonly timers: TimerSet;
  private gInterval: number;
  /** Fired once on terminated; `ackTimeout` when Timer H expired without an ACK. */
  onTerminated?: (reason: 'normal' | 'ack-timeout') => void;

  constructor(
    readonly key: string,
    readonly request: SipRequest,
    readonly flow: Flow,
    private readonly ctx: TransactionContext,
  ) {
    this.timers = new TimerSet(ctx.clock);
    this.state = request.method === 'INVITE' ? 'proceeding' : 'trying';
    this.gInterval = ctx.timers.t1;
  }

  get isInvite(): boolean {
    return this.request.method === 'INVITE';
  }

  get lastResponse(): SipResponse | undefined {
    return this.last;
  }

  /** Whether a final response was already sent (a CANCEL then gets 200 but changes nothing). */
  get finished(): boolean {
    return this.state !== 'trying' && this.state !== 'proceeding';
  }

  respond(response: SipResponse): void {
    if (this.finished) return;
    this.last = response;
    this.ctx.send(response, this.flow);
    const { t1, t2 } = this.ctx.timers;
    if (response.status < 200) {
      this.state = 'proceeding';
      return;
    }
    if (!this.isInvite) {
      this.state = 'completed';
      this.timers.start('J', reliable(this.flow) ? 0 : 64 * t1, () => this.terminate('normal'));
      return;
    }
    if (response.status < 300) {
      this.state = 'accepted';
      this.timers.start('L', 64 * t1, () => this.terminate('normal'));
      return;
    }
    this.state = 'completed';
    if (!reliable(this.flow)) this.scheduleG(t2);
    this.timers.start('H', 64 * t1, () => this.terminate('ack-timeout'));
  }

  private scheduleG(t2: number): void {
    this.timers.start('G', this.gInterval, () => {
      if (this.state !== 'completed' || !this.last) return;
      this.ctx.send(this.last, this.flow);
      this.gInterval = Math.min(2 * this.gInterval, t2);
      this.scheduleG(t2);
    });
  }

  /** A retransmitted request: resend the last response (none in "trying"; none in "accepted"). */
  retransmitted(): void {
    if ((this.state === 'proceeding' || this.state === 'completed') && this.last)
      this.ctx.send(this.last, this.flow);
  }

  /** ACK for a non-2xx final: stop retransmitting and absorb further ACKs for Timer I. */
  acked(): void {
    if (this.state !== 'completed' || !this.isInvite) return;
    this.state = 'confirmed';
    this.timers.stop('G');
    this.timers.stop('H');
    this.timers.start('I', reliable(this.flow) ? 0 : this.ctx.timers.t4, () =>
      this.terminate('normal'),
    );
  }

  terminate(reason: 'normal' | 'ack-timeout' = 'normal'): void {
    if (this.state === 'terminated') return;
    this.state = 'terminated';
    this.timers.stopAll();
    this.onTerminated?.(reason);
  }
}
