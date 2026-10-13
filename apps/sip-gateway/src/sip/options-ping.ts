import type { Clock } from '@winsendotai/ovo-contracts';
import type { Trunk } from '../config/trunks.ts';
import type { Logger } from '../log.ts';
import type { Flow } from './flow.ts';
import { SipHeaders, type SipRequest } from './message.ts';
import { USER_AGENT, newTag } from './serialize.ts';
import type { TransactionLayer } from './transactions.ts';

export type TrunkState = 'up' | 'down' | 'unknown';

export interface PingHost {
  clock: Clock;
  logger: Logger;
  transactions: TransactionLayer;
  advertisedHost: string;
  via(transport: Flow['transport']): string;
  resolve(uri: string, transport: Flow['transport']): Promise<Flow>;
}

/**
 * OPTIONS keep-alive to each trunk's outbound next hop every `optionsPingSeconds` (§4.6). Any final
 * response means the hop is alive (a 404 or 405 still proves a SIP stack answered); a transaction
 * timeout marks it down. Inbound-only trunks have no next hop and stay `unknown`.
 */
export class OptionsPinger {
  private readonly states = new Map<string, TrunkState>();
  private readonly cancels: (() => void)[] = [];
  private seq = 0;

  constructor(
    private readonly host: PingHost,
    private readonly trunks: readonly Trunk[],
  ) {
    for (const trunk of trunks) this.states.set(trunk.id, 'unknown');
  }

  snapshot(): Record<string, TrunkState> {
    return Object.fromEntries(this.states);
  }

  start(): void {
    for (const trunk of this.trunks) {
      if (!trunk.outbound.proxy || trunk.optionsPingSeconds <= 0) continue;
      const loop = () => {
        void this.ping(trunk);
        this.cancels.push(this.host.clock.setTimeout(loop, trunk.optionsPingSeconds * 1000));
      };
      loop();
    }
  }

  stop(): void {
    for (const cancel of this.cancels.splice(0)) cancel();
  }

  async ping(trunk: Trunk): Promise<TrunkState> {
    let flow: Flow;
    try {
      flow = await this.host.resolve(trunk.outbound.proxy!, trunk.transport);
    } catch {
      return this.set(trunk, 'down');
    }
    const request = this.request(trunk.outbound.proxy!, flow);
    return new Promise((resolve) => {
      this.host.transactions.request(request, flow, {
        onResponse: (response) => {
          if (response.status >= 200) resolve(this.set(trunk, 'up'));
        },
        onTimeout: () => resolve(this.set(trunk, 'down')),
      });
    });
  }

  private request(uri: string, flow: Flow): SipRequest {
    this.seq += 1;
    const headers = new SipHeaders()
      .append('via', this.host.via(flow.transport))
      .append('max-forwards', '70')
      .append('from', `<sip:ovo@${this.host.advertisedHost}>;tag=${newTag()}`)
      .append('to', `<${uri.split(';')[0]}>`)
      .append('call-id', `ping-${newTag()}@${this.host.advertisedHost}`)
      .append('cseq', `${this.seq} OPTIONS`)
      .append('user-agent', USER_AGENT)
      .append('accept', 'application/sdp');
    return {
      kind: 'request',
      method: 'OPTIONS',
      uri: uri.split(';')[0]!,
      headers,
      body: new Uint8Array(),
    };
  }

  private set(trunk: Trunk, state: TrunkState): TrunkState {
    const previous = this.states.get(trunk.id);
    this.states.set(trunk.id, state);
    if (previous !== state)
      this.host.logger.info('sip.trunk', { trunk: trunk.id, state, previous });
    return state;
  }
}
