import { parseNameAddr, parseUri } from './address.ts';
import { SipHeaders, parseCSeq, type SipRequest, type SipResponse } from './message.ts';

/** The next hop of an in-dialog request: the first loose route, else the remote target. */
export interface NextHop {
  uri: string;
  transport?: 'udp' | 'tcp';
}

export const tagOf = (header: string | undefined): string | undefined => {
  const tag = parseNameAddr(header ?? '')?.params.tag;
  return typeof tag === 'string' ? tag : undefined;
};

const contactUri = (message: SipRequest | SipResponse): string | undefined =>
  parseNameAddr(message.headers.getAll('contact')[0] ?? '')?.uri;

/** RFC 3261 §12: dialog state and in-dialog request construction with loose routing. */
export class Dialog {
  remoteSeq?: number;

  private constructor(
    readonly callId: string,
    readonly localTag: string,
    readonly remoteTag: string,
    /** Our From/To header value (with our tag). */
    readonly local: string,
    /** Their From/To header value (with their tag). */
    readonly remote: string,
    public remoteTarget: string,
    readonly routeSet: readonly string[],
    public localSeq: number,
  ) {}

  /** UAS side: the INVITE we answered (Record-Route kept in order). */
  static asUas(invite: SipRequest, localTag: string): Dialog {
    const to = invite.headers.get('to') ?? '';
    const dialog = new Dialog(
      invite.headers.get('call-id') ?? '',
      localTag,
      tagOf(invite.headers.get('from')) ?? '',
      /;\s*tag=/i.test(to) ? to : `${to};tag=${localTag}`,
      invite.headers.get('from') ?? '',
      contactUri(invite) ?? invite.uri,
      invite.headers.getAll('record-route'),
      Math.floor(Math.random() * 10_000) + 1,
    );
    dialog.remoteSeq = parseCSeq(invite.headers.get('cseq'))?.seq;
    return dialog;
  }

  /** UAC side: our INVITE and the 2xx that created the dialog (Record-Route reversed). */
  static asUac(invite: SipRequest, response: SipResponse): Dialog {
    return new Dialog(
      invite.headers.get('call-id') ?? '',
      tagOf(invite.headers.get('from')) ?? '',
      tagOf(response.headers.get('to')) ?? '',
      invite.headers.get('from') ?? '',
      response.headers.get('to') ?? '',
      contactUri(response) ?? invite.uri,
      [...response.headers.getAll('record-route')].reverse(),
      parseCSeq(invite.headers.get('cseq'))?.seq ?? 1,
    );
  }

  /** Whether `request` belongs here: Call-ID plus their tag in From and ours in To. */
  matches(request: SipRequest): boolean {
    return (
      request.headers.get('call-id') === this.callId &&
      tagOf(request.headers.get('from')) === this.remoteTag &&
      tagOf(request.headers.get('to')) === this.localTag
    );
  }

  /**
   * RFC 3261 §12.2.1.2: Request-URI and Route for an in-dialog request. A strict-routing first
   * hop (no `lr`) is honoured by moving the remote target to the end of the Route set.
   */
  route(): { uri: string; routes: string[]; nextHop: NextHop } {
    const first = this.routeSet[0];
    const firstUri = first ? parseNameAddr(first)?.uri : undefined;
    const loose = firstUri ? parseUri(firstUri)?.params.lr !== undefined : true;
    const uri = loose || !firstUri ? this.remoteTarget : firstUri;
    const routes = loose
      ? [...this.routeSet]
      : [...this.routeSet.slice(1), `<${this.remoteTarget}>`];
    const hop = firstUri ?? this.remoteTarget;
    const transport = parseUri(hop)?.params.transport;
    return {
      uri,
      routes,
      nextHop: {
        uri: hop,
        ...(transport === 'tcp' || transport === 'udp' ? { transport } : {}),
      },
    };
  }

  /** A new in-dialog request (BYE, re-INVITE, INFO); `via` is added by the caller. */
  request(method: string, extra: [string, string][] = [], body?: Uint8Array): SipRequest {
    const { uri, routes } = this.route();
    this.localSeq += 1;
    const headers = new SipHeaders();
    for (const route of routes) headers.append('route', route);
    headers.append('max-forwards', '70');
    headers.append('from', this.local);
    headers.append('to', this.remote);
    headers.append('call-id', this.callId);
    headers.append('cseq', `${this.localSeq} ${method}`);
    for (const [name, value] of extra) headers.append(name, value);
    return { kind: 'request', method, uri, headers, body: body ?? new Uint8Array() };
  }

  /** The ACK for a 2xx: same CSeq number as the INVITE, routed like any in-dialog request. */
  ack(inviteSeq: number, extra: [string, string][] = []): SipRequest {
    const request = this.request('ACK', extra);
    this.localSeq -= 1;
    request.headers.set('cseq', `${inviteSeq} ACK`);
    return request;
  }

  /** Remote CSeq must grow (RFC 3261 §12.2.2); a lower one gets a 500. */
  acceptRemoteSeq(request: SipRequest): boolean {
    const seq = parseCSeq(request.headers.get('cseq'))?.seq;
    if (seq === undefined) return false;
    if (this.remoteSeq !== undefined && seq <= this.remoteSeq && request.method !== 'ACK')
      return false;
    if (request.method !== 'ACK') this.remoteSeq = seq;
    return true;
  }
}
