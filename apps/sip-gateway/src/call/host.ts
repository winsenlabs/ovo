import type { BridgeTarget } from '../bridge/signed-http.ts';
import type { GatewayClock } from '../clock.ts';
import type { GatewayConfig } from '../config/env.ts';
import type { Trunk } from '../config/trunks.ts';
import type { Logger } from '../log.ts';
import type { RtpSocketPool } from '../rtp/socket-pool.ts';
import type { Flow } from '../sip/flow.ts';
import type { SipMessage } from '../sip/message.ts';
import type { TransactionLayer } from '../sip/transactions.ts';
import type { Counters } from '../telemetry.ts';
import type { CallRegistry } from './registry.ts';

/** What a call needs from the gateway process. */
export interface CallHost {
  readonly config: GatewayConfig;
  readonly clock: GatewayClock;
  readonly logger: Logger;
  readonly counters: Counters;
  readonly pool: RtpSocketPool;
  readonly bridge: BridgeTarget;
  readonly transactions: TransactionLayer;
  readonly registry: CallRegistry;
  readonly draining: boolean;
  send(message: SipMessage, flow: Flow): void;
  /** A fresh top Via for a request we send on `transport`. */
  via(transport: Flow['transport']): string;
  contact(transport: Flow['transport']): string;
  /** A next-hop URI as a flow (literal IPv4 or an A-record lookup). */
  resolve(uri: string, transport: Flow['transport']): Promise<Flow>;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** The trunk's INVITE token bucket (`inviteRatePerSecond`); false when over the rate. */
  trunkRate(trunk: Trunk): boolean;
  callEnded(callId: string): void;
}
