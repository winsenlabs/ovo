import { TimerSet, reliable, type Flow, type TransactionContext } from './flow.ts';
import { SipHeaders, parseCSeq, type SipRequest, type SipResponse } from './message.ts';

export type ClientState =
  'calling' | 'trying' | 'proceeding' | 'completed' | 'accepted' | 'terminated';

export interface ClientHandlers {
  /** Every provisional, every 2xx (forks included) and the first non-2xx final. */
  onResponse(response: SipResponse): void;
  /** Timer B or F: no final response. */
  onTimeout(): void;
}

/** The ACK for a non-2xx final belongs to the INVITE transaction (RFC 3261 §17.1.1.3). */
export function ackForFailure(invite: SipRequest, response: SipResponse): SipRequest {
  const headers = new SipHeaders();
  headers.append('via', invite.headers.getAll('via')[0] ?? '');
  for (const route of invite.headers.getAll('route')) headers.append('route', route);
  headers.append('max-forwards', '70');
  headers.append('from', invite.headers.get('from') ?? '');
  headers.append('to', response.headers.get('to') ?? '');
  headers.append('call-id', invite.headers.get('call-id') ?? '');
  headers.append('cseq', `${parseCSeq(invite.headers.get('cseq'))?.seq ?? 1} ACK`);
  return { kind: 'request', method: 'ACK', uri: invite.uri, headers, body: new Uint8Array() };
}

/**
 * RFC 3261 §17.1 client transactions. INVITE: Timer A doubles without a cap, Timer B gives up;
 * a 2xx moves to RFC 6026 "Accepted" for Timer M so forked 2xx still reach the TU. Non-INVITE:
 * Timer E doubles to T2, Timer F gives up.
 */
export class ClientTransaction {
  state: ClientState;
  private readonly timers: TimerSet;
  private interval: number;
  private ack?: SipRequest;
  onTerminated?: () => void;

  constructor(
    readonly key: string,
    readonly request: SipRequest,
    readonly flow: Flow,
    private readonly ctx: TransactionContext,
    private readonly handlers: ClientHandlers,
  ) {
    this.timers = new TimerSet(ctx.clock);
    this.interval = ctx.timers.t1;
    this.state = request.method === 'INVITE' ? 'calling' : 'trying';
    ctx.send(request, flow);
    const { t1 } = ctx.timers;
    if (!reliable(flow)) this.scheduleRetransmit();
    this.timers.start(this.isInvite ? 'B' : 'F', 64 * t1, () => {
      if (this.state === 'calling' || this.state === 'trying' || this.state === 'proceeding') {
        this.terminate();
        handlers.onTimeout();
      }
    });
  }

  get isInvite(): boolean {
    return this.request.method === 'INVITE';
  }

  private scheduleRetransmit(): void {
    this.timers.start(this.isInvite ? 'A' : 'E', this.interval, () => {
      const active = this.isInvite ? this.state === 'calling' : this.state !== 'completed';
      if (!active || this.state === 'terminated') return;
      this.ctx.send(this.request, this.flow);
      this.interval = this.isInvite
        ? 2 * this.interval
        : Math.min(2 * this.interval, this.ctx.timers.t2);
      this.scheduleRetransmit();
    });
  }

  receive(response: SipResponse): void {
    const { t1, t4 } = this.ctx.timers;
    if (this.state === 'terminated') return;
    if (response.status < 200) {
      if (this.state === 'calling' || this.state === 'trying') {
        this.state = 'proceeding';
        if (this.isInvite) this.timers.stop('A');
        else this.interval = this.ctx.timers.t2;
      }
      if (this.state === 'proceeding') this.handlers.onResponse(response);
      return;
    }
    if (this.isInvite && response.status < 300) {
      if (this.state !== 'accepted') {
        this.state = 'accepted';
        this.timers.stop('A');
        this.timers.stop('B');
        this.timers.start('M', 64 * t1, () => this.terminate());
      }
      this.handlers.onResponse(response);
      return;
    }
    if (this.state === 'completed' || this.state === 'accepted') {
      // A retransmitted final: only the ACK is resent, the TU has already seen it.
      if (this.ack) this.ctx.send(this.ack, this.flow);
      return;
    }
    this.state = 'completed';
    this.timers.stop('A');
    this.timers.stop('B');
    this.timers.stop('E');
    this.timers.stop('F');
    if (this.isInvite) {
      this.ack = ackForFailure(this.request, response);
      this.ctx.send(this.ack, this.flow);
      this.timers.start('D', reliable(this.flow) ? 0 : 32_000, () => this.terminate());
    } else this.timers.start('K', reliable(this.flow) ? 0 : t4, () => this.terminate());
    this.handlers.onResponse(response);
  }

  terminate(): void {
    if (this.state === 'terminated') return;
    this.state = 'terminated';
    this.timers.stopAll();
    this.onTerminated?.();
  }
}
