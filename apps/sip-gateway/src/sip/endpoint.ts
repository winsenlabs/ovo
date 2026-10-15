import { lookup } from 'node:dns/promises';
import { isIPv4 } from 'node:net';
import type { GatewayClock } from '../clock.ts';
import type { Logger } from '../log.ts';
import { sourceLimits } from '../policy/ratelimit.ts';
import type { Counters, DropLog } from '../telemetry.ts';
import { formatVia, parseUri, parseVia } from './address.ts';
import type { Flow, SipTimers } from './flow.ts';
import type { SipMessage, SipRequest } from './message.ts';
import { SipParseError, parseMessage } from './parse.ts';
import { createResponse, newBranch, serialize } from './serialize.ts';
import { TransactionLayer, type TransactionUser } from './transactions.ts';
import { TcpTransport } from './transport-tcp.ts';
import { UdpTransport } from './transport-udp.ts';

export interface EndpointOptions {
  bindHost: string;
  advertisedHost: string;
  port: number;
  transports: readonly ('udp' | 'tcp')[];
  timers: SipTimers;
  clock: GatewayClock;
  logger: Logger;
  counters: Counters;
  drops: DropLog;
  /** The layer-2 allow-list, checked on the raw source address before any byte is parsed. */
  allow(address: string): boolean;
  tu: TransactionUser;
  /** DNS for next hops that are names; tests inject a fake. */
  lookup?: (host: string) => Promise<string>;
}

const plain = (address: string) => (address.startsWith('::ffff:') ? address.slice(7) : address);

/**
 * The SIP endpoint: UDP and TCP sockets, the pre-parse allow-list, the parser limits, per-source
 * token buckets, RFC 3581 `received`/`rport`, and the transaction layer above them.
 */
export class SipEndpoint {
  readonly transactions: TransactionLayer;
  private udp?: UdpTransport;
  private tcp?: TcpTransport;
  private readonly limits;

  constructor(private readonly options: EndpointOptions) {
    this.limits = sourceLimits(options.clock);
    this.transactions = new TransactionLayer(
      {
        send: (message, flow) => this.send(message, flow),
        clock: options.clock,
        timers: options.timers,
      },
      options.tu,
    );
  }

  async start(): Promise<void> {
    const { bindHost, transports } = this.options;
    let port = this.options.port;
    if (transports.includes('udp')) {
      this.udp = await UdpTransport.listen(bindHost, port, {
        allow: (address) => this.options.allow(plain(address)),
        onDatagram: (data, source) => this.receive(data, { transport: 'udp', ...source }),
        onDrop: (reason, address) => this.options.drops.drop(reason, address),
      });
      port = this.udp.port;
    }
    if (transports.includes('tcp'))
      this.tcp = await TcpTransport.listen(bindHost, port, {
        allow: (address) => this.options.allow(plain(address)),
        onMessage: (data, source, connectionId) =>
          this.receive(data, {
            transport: 'tcp',
            address: plain(source.address),
            port: source.port,
            connectionId,
          }),
        onDrop: (reason, address) => this.options.drops.drop(reason, plain(address)),
      });
  }

  /** The bound SIP port (UDP and TCP share it). */
  get port(): number {
    return this.udp?.port ?? this.tcp?.port ?? this.options.port;
  }

  get tcpConnections(): number {
    return this.tcp?.connectionCount ?? 0;
  }

  private receive(data: Buffer, flow: Flow): void {
    let message: SipMessage;
    try {
      message = parseMessage(data, flow.transport);
    } catch (error) {
      if (!(error instanceof SipParseError)) throw error;
      this.options.drops.drop(error.reason === 'oversize' ? 'oversize' : 'malformed', flow.address);
      if (error.respondable && error.partial?.kind === 'request' && error.partial.method !== 'ACK')
        this.send(createResponse(error.partial, 400, { reason: 'Bad Request' }), flow);
      return;
    }
    if (!this.limits.all.take(flow.address))
      return this.options.drops.drop('rate_limited', flow.address);
    if (message.kind === 'request') {
      stampVia(message, flow);
      if (
        message.method === 'INVITE' &&
        !/;\s*tag=/i.test(message.headers.get('to') ?? '') &&
        !this.limits.invite.take(flow.address)
      ) {
        this.options.drops.drop('rate_limited', flow.address);
        this.send(createResponse(message, 503, { headers: [['Retry-After', '1']] }), flow);
        return;
      }
    }
    try {
      this.transactions.receive(message, flow);
    } catch (error) {
      this.options.logger.error('sip.handler_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  send(message: SipMessage, flow: Flow): void {
    const bytes = serialize(message);
    if (flow.transport === 'udp') {
      if (!this.udp) throw new Error('UDP transport is not enabled');
      this.udp.send(bytes, flow.address, flow.port);
      return;
    }
    if (!this.tcp) throw new Error('TCP transport is not enabled');
    this.tcp.send(bytes, flow.address, flow.port, flow.connectionId).catch((error: Error) =>
      this.options.logger.warn('sip.tcp_send_failed', {
        address: flow.address,
        port: flow.port,
        error: error.message,
      }),
    );
  }

  /** A fresh top Via for a request we send (RFC 3261 §8.1.1.7, RFC 3581 `rport`). */
  via(transport: Flow['transport']): string {
    return formatVia({
      transport: transport.toUpperCase(),
      host: this.options.advertisedHost,
      port: this.port,
      params: { branch: newBranch(), rport: true },
    });
  }

  contact(transport: Flow['transport']): string {
    const suffix = transport === 'tcp' ? ';transport=tcp' : '';
    return `<sip:ovo@${this.options.advertisedHost}:${this.port}${suffix}>`;
  }

  /** A next-hop URI as a flow: a literal IPv4 host, or one A-record lookup. */
  async resolve(uri: string, transport: Flow['transport']): Promise<Flow> {
    const parsed = parseUri(uri);
    if (!parsed || parsed.scheme === 'tel') throw new TypeError(`Cannot route to ${uri}`);
    const named = parsed.params.transport;
    const chosen = named === 'tcp' || named === 'udp' ? named : transport;
    const address = isIPv4(parsed.host)
      ? parsed.host
      : await (this.options.lookup ?? defaultLookup)(parsed.host);
    return { transport: chosen, address, port: parsed.port ?? 5060 };
  }

  async close(): Promise<void> {
    this.transactions.close();
    await Promise.all([this.udp?.close(), this.tcp?.close()]);
  }
}

async function defaultLookup(host: string): Promise<string> {
  return (await lookup(host, { family: 4 })).address;
}

/** RFC 3261 §18.2.1 `received` and RFC 3581 `rport` on the top Via of a request we received. */
export function stampVia(request: SipRequest, flow: Flow): void {
  const vias = request.headers.getAll('via');
  const top = vias[0] ? parseVia(vias[0]) : undefined;
  if (!top) return;
  let changed = false;
  if (top.host !== flow.address) {
    top.params.received = flow.address;
    changed = true;
  }
  if (top.params.rport !== undefined) {
    top.params.rport = String(flow.port);
    top.params.received = flow.address;
    changed = true;
  }
  if (!changed) return;
  request.headers.delete('via');
  request.headers.append('via', formatVia(top));
  for (const via of vias.slice(1)) request.headers.append('via', via);
}
