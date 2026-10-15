import type { BridgeTarget } from './bridge/signed-http.ts';
import { Call } from './call/call.ts';
import type { CallHost } from './call/host.ts';
import { inDialog } from './call/in-dialog.ts';
import { handleInvite } from './call/inbound.ts';
import { CallRegistry } from './call/registry.ts';
import { systemClock, type GatewayClock } from './clock.ts';
import type { GatewayConfig } from './config/env.ts';
import { trunkForSource, type Trunk } from './config/trunks.ts';
import { rootLogger, type Logger } from './log.ts';
import { KeyedBuckets } from './policy/ratelimit.ts';
import { RtpSocketPool } from './rtp/socket-pool.ts';
import { SipEndpoint } from './sip/endpoint.ts';
import type { Flow } from './sip/flow.ts';
import {
  ALLOWED_METHODS,
  type SipMessage,
  type SipRequest,
  type SipResponse,
} from './sip/message.ts';
import { OptionsPinger } from './sip/options-ping.ts';
import { createResponse } from './sip/serialize.ts';
import type { ServerTransaction } from './sip/server-transaction.ts';
import type { TransactionLayer, TransactionUser } from './sip/transactions.ts';
import { Counters, DropLog } from './telemetry.ts';

/** Option tags we understand in `Require`; anything else is a 420 (we never do 100rel). */
const SUPPORTED_EXTENSIONS = new Set(['timer']);

export interface GatewayOptions {
  config: GatewayConfig;
  clock?: GatewayClock;
  logger?: Logger;
  fetch?: typeof fetch;
  /** DNS for next hops; tests inject a fake. */
  lookup?: (host: string) => Promise<string>;
}

/**
 * The sip-gateway process core: the SIP endpoint, the RTP pool, live calls, the trunk keep-alive
 * and drain. It is the transaction user for every request no transaction absorbed.
 */
export class SipGateway implements CallHost, TransactionUser {
  readonly config: GatewayConfig;
  readonly clock: GatewayClock;
  readonly logger: Logger;
  readonly counters = new Counters();
  readonly drops: DropLog;
  readonly pool: RtpSocketPool;
  readonly bridge: BridgeTarget;
  readonly registry: CallRegistry;
  readonly endpoint: SipEndpoint;
  readonly pinger: OptionsPinger;
  draining = false;
  private readonly trunkBuckets = new Map<string, KeyedBuckets>();
  private readonly drained = new Set<() => void>();

  constructor(options: GatewayOptions) {
    this.config = options.config;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? rootLogger;
    this.drops = new DropLog(this.logger, this.counters);
    this.registry = new CallRegistry(this.clock);
    this.pool = new RtpSocketPool({
      address: this.config.bindHost,
      ...this.config.rtpPorts,
      clock: this.clock,
    });
    this.bridge = {
      internalUrl: this.config.mediaInternalUrl,
      publicBaseUrl: this.config.publicBaseUrl,
      key: this.config.keys.current,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    };
    this.endpoint = new SipEndpoint({
      bindHost: this.config.bindHost,
      advertisedHost: this.config.advertisedHost,
      port: this.config.sipPort,
      transports: this.config.transports,
      timers: this.config.timers,
      clock: this.clock,
      logger: this.logger,
      counters: this.counters,
      drops: this.drops,
      allow: (address) => trunkForSource(this.config.trunks, address) !== undefined,
      tu: this,
      ...(options.lookup ? { lookup: options.lookup } : {}),
    });
    this.pinger = new OptionsPinger(
      {
        clock: this.clock,
        logger: this.logger,
        transactions: this.endpoint.transactions,
        advertisedHost: this.config.advertisedHost,
        via: (transport) => this.via(transport),
        resolve: (uri, transport) => this.resolve(uri, transport),
      },
      this.config.trunks,
    );
  }

  async start(): Promise<void> {
    await this.endpoint.start();
    this.pinger.start();
  }

  get transactions(): TransactionLayer {
    return this.endpoint.transactions;
  }

  send(message: SipMessage, flow: Flow): void {
    this.endpoint.send(message, flow);
  }

  via(transport: Flow['transport']): string {
    return this.endpoint.via(transport);
  }

  contact(transport: Flow['transport']): string {
    return this.endpoint.contact(transport);
  }

  resolve(uri: string, transport: Flow['transport']): Promise<Flow> {
    return this.endpoint.resolve(uri, transport);
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('aborted'));
      const cancel = this.clock.setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        cancel();
        reject(new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  trunkRate(trunk: Trunk): boolean {
    let bucket = this.trunkBuckets.get(trunk.id);
    if (!bucket) {
      const rate = trunk.inviteRatePerSecond;
      bucket = new KeyedBuckets(rate, Math.max(1, Math.ceil(rate)), this.clock, 1);
      this.trunkBuckets.set(trunk.id, bucket);
    }
    return bucket.take(trunk.id);
  }

  callEnded(callId: string): void {
    this.registry.remove(callId);
    if (this.registry.size === 0) for (const resolve of this.drained) resolve();
  }

  onRequest(request: SipRequest, flow: Flow, tx?: ServerTransaction): void {
    const reply = (status: number, headers: [string, string][] = []) =>
      tx!.respond(createResponse(request, status, { headers }));
    if (request.method === 'ACK') return this.inDialogRequest(request, flow);
    // No RFC 3261 branch, so no transaction to answer through: outside the trunk profile.
    if (!tx) return this.drops.drop('malformed', flow.address);
    if (!ALLOWED_METHODS.includes(request.method))
      return reply(405, [['Allow', ALLOWED_METHODS.join(', ')]]);
    if (request.method === 'CANCEL') return this.cancel(request, tx);
    if (/;\s*tag=/i.test(request.headers.get('to') ?? ''))
      return this.inDialogRequest(request, flow, tx);
    switch (request.method) {
      case 'OPTIONS':
        return this.draining
          ? reply(503, [['Retry-After', '30']])
          : reply(200, [
              ['Allow', ALLOWED_METHODS.join(', ')],
              ['Accept', 'application/sdp'],
              ['Supported', 'timer'],
            ]);
      case 'INVITE': {
        const unsupported = request.headers
          .getAll('require')
          .filter((tag) => !SUPPORTED_EXTENSIONS.has(tag.toLowerCase()));
        if (unsupported.length) return reply(420, [['Unsupported', unsupported.join(', ')]]);
        handleInvite(this, request, flow, tx).catch((error: Error) => {
          this.logger.error('sip.invite_failed', { error: error.message });
          if (!tx.finished) reply(500);
        });
        return;
      }
      default:
        return reply(481);
    }
  }

  private inDialogRequest(request: SipRequest, flow: Flow, tx?: ServerTransaction): void {
    const call = this.registry.get(request.headers.get('call-id'));
    if (!call?.dialog?.matches(request) || call.phase === 'ended') {
      if (request.method !== 'ACK') tx?.respond(createResponse(request, 481));
      return;
    }
    inDialog(call, request, flow, tx);
  }

  /** CANCEL: 200 for the CANCEL itself, then 487 for an INVITE still being decided. */
  private cancel(request: SipRequest, tx?: ServerTransaction): void {
    const invite = this.transactions.inviteFor(request);
    if (!invite) return void tx?.respond(createResponse(request, 481));
    tx?.respond(createResponse(request, 200));
    if (invite.finished) return;
    const call = this.registry.get(request.headers.get('call-id'));
    if (call)
      call.end('caller_cancel', {
        bye: false,
        stream: 'caller-hangup',
        state: 'canceled',
        sipCode: 487,
      });
    else invite.respond(createResponse(invite.request, 487));
  }

  onStrayResponse(response: SipResponse): void {
    this.logger.debug('sip.stray_response', { status: response.status });
  }

  /** The control API's hangup: CANCEL or 487 before answer, BYE after. */
  hangup(call: Call): 'ended' | 'already_ended' {
    if (call.phase === 'ending' || call.phase === 'ended') return 'already_ended';
    if (call.phase === 'early')
      call.end('host_hangup', { bye: false, stream: 'gateway', state: 'canceled', sipCode: 480 });
    else call.end('host_hangup', { bye: true, stream: 'stream-ended' });
    return 'ended';
  }

  /**
   * SIGTERM (§4.6): refuse new work with 503, let live dialogs finish for `drainTimeoutMs`, then
   * BYE (or CANCEL) whatever is left with normal clearing.
   */
  async drain(): Promise<void> {
    if (!this.draining) this.logger.info('sip.drain', { calls: this.registry.size });
    this.draining = true;
    if (this.registry.size) {
      let cancel = () => {};
      await new Promise<void>((resolve) => {
        const done = () => {
          cancel();
          this.drained.delete(done);
          resolve();
        };
        this.drained.add(done);
        cancel = this.clock.setTimeout(done, this.config.drainTimeoutMs);
      });
    }
    for (const call of this.registry.all())
      call.end(
        'drain',
        call.phase === 'early'
          ? { bye: false, stream: 'gateway', state: 'failed', sipCode: 503 }
          : { bye: true, stream: 'stream-ended' },
      );
  }

  async close(): Promise<void> {
    for (const call of this.registry.all())
      call.end('shutdown', { bye: false, stream: 'stream-ended', state: 'failed' });
    this.pinger.stop();
    this.drops.close();
    this.pool.close();
    await this.endpoint.close();
  }
}
