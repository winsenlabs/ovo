import { parseVia } from './address.ts';
import { ClientTransaction, type ClientHandlers } from './client-transaction.ts';
import type { Flow, TransactionContext } from './flow.ts';
import { parseCSeq, type SipMessage, type SipRequest, type SipResponse } from './message.ts';
import { ServerTransaction } from './server-transaction.ts';

const MAGIC = 'z9hG4bK';

/** RFC 3261 §17.2.3: branch + sent-by + method, with ACK matching its INVITE. */
export function serverKey(request: SipRequest): string | undefined {
  const via = parseVia(request.headers.getAll('via')[0] ?? '');
  const branch = typeof via?.params.branch === 'string' ? via.params.branch : undefined;
  if (!via || !branch?.startsWith(MAGIC)) return undefined;
  const method = request.method === 'ACK' ? 'INVITE' : request.method;
  return `${branch}|${via.host}:${via.port ?? 5060}|${method}`;
}

/** RFC 3261 §17.1.3: top Via branch + CSeq method. */
export function clientKey(message: SipMessage): string | undefined {
  const via = parseVia(message.headers.getAll('via')[0] ?? '');
  const branch = typeof via?.params.branch === 'string' ? via.params.branch : undefined;
  const method = parseCSeq(message.headers.get('cseq'))?.method;
  if (!branch || !method) return undefined;
  return `${branch}|${method === 'ACK' ? 'INVITE' : method}`;
}

export interface TransactionUser {
  /** A new request: a server transaction exists for everything but ACK. */
  onRequest(request: SipRequest, flow: Flow, transaction?: ServerTransaction): void;
  /** A response no client transaction owns (a 2xx retransmission after Timer M, a stray). */
  onStrayResponse(response: SipResponse, flow: Flow): void;
}

/** Matches messages to transactions; everything else goes to the TU (the gateway core). */
export class TransactionLayer {
  private readonly servers = new Map<string, ServerTransaction>();
  private readonly clients = new Map<string, ClientTransaction>();

  constructor(
    private readonly ctx: TransactionContext,
    private readonly tu: TransactionUser,
  ) {}

  get counts() {
    return { server: this.servers.size, client: this.clients.size };
  }

  receive(message: SipMessage, flow: Flow): void {
    if (message.kind === 'response') {
      const key = clientKey(message);
      const tx = key ? this.clients.get(key) : undefined;
      if (tx) tx.receive(message);
      else this.tu.onStrayResponse(message, flow);
      return;
    }
    const key = serverKey(message);
    const existing = key ? this.servers.get(key) : undefined;
    if (message.method === 'ACK') {
      // A non-2xx ACK carries the INVITE branch; a 2xx ACK is a new branch and goes to the TU.
      if (existing && existing.state === 'completed') existing.acked();
      else if (!existing || existing.state === 'accepted') this.tu.onRequest(message, flow);
      return;
    }
    if (existing) {
      existing.retransmitted();
      return;
    }
    if (!key) {
      // RFC 2543 peers without a magic cookie are outside the trunk profile: no transaction.
      this.tu.onRequest(message, flow);
      return;
    }
    const tx = new ServerTransaction(key, message, flow, this.ctx);
    this.servers.set(key, tx);
    tx.onTerminated = () => this.servers.delete(key);
    this.tu.onRequest(message, flow, tx);
  }

  /** The INVITE server transaction a CANCEL names (same branch, RFC 3261 §9.2). */
  inviteFor(cancel: SipRequest): ServerTransaction | undefined {
    const key = serverKey(cancel);
    return key ? this.servers.get(key.replace(/\|CANCEL$/, '|INVITE')) : undefined;
  }

  request(request: SipRequest, flow: Flow, handlers: ClientHandlers): ClientTransaction {
    const key = clientKey(request);
    if (!key) throw new TypeError('A client request needs a Via branch and a CSeq');
    const tx = new ClientTransaction(key, request, flow, this.ctx, handlers);
    this.clients.set(key, tx);
    tx.onTerminated = () => this.clients.delete(key);
    if (tx.state === 'terminated') this.clients.delete(key);
    return tx;
  }

  close(): void {
    for (const tx of [...this.servers.values()]) tx.terminate();
    for (const tx of [...this.clients.values()]) tx.terminate();
  }
}
