import { randomBytes } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';
import { serializeRtp, parseRtp, type RtpPacket } from '../../src/rtp/packet.ts';
import {
  SipHeaders,
  type SipMessage,
  type SipRequest,
  type SipResponse,
} from '../../src/sip/message.ts';
import { parseMessage } from '../../src/sip/parse.ts';
import { createResponse, serialize } from '../../src/sip/serialize.ts';

const hex = (bytes: number) => randomBytes(bytes).toString('hex');

/**
 * A minimal UDP SIP peer for in-process tests: it plays the trunk (UAC for inbound calls, UAS for
 * outbound ones), records every message and lets a test wait for the next match.
 */
export class SipPeer {
  readonly received: SipMessage[] = [];
  private unclaimed: SipMessage[] = [];
  private waiters: { match: (m: SipMessage) => boolean; resolve: (m: SipMessage) => void }[] = [];
  private constructor(private readonly socket: Socket) {
    socket.on('message', (data) => {
      const message = parseMessage(data, 'udp');
      this.received.push(message);
      const waiter = this.waiters.find((w) => w.match(message));
      if (waiter) {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        waiter.resolve(message);
      } else this.unclaimed.push(message);
    });
  }

  static async open(port = 0): Promise<SipPeer> {
    const socket = createSocket('udp4');
    await new Promise<void>((resolve) => socket.bind(port, '127.0.0.1', resolve));
    return new SipPeer(socket);
  }

  get port(): number {
    return this.socket.address().port;
  }

  send(message: SipMessage, port: number): void {
    this.socket.send(serialize(message), port, '127.0.0.1');
  }

  sendRaw(bytes: Uint8Array, port: number): void {
    this.socket.send(bytes, port, '127.0.0.1');
  }

  /** The next message (already received and unclaimed, or future) that matches. */
  next(match: (m: SipMessage) => boolean, timeoutMs = 5_000): Promise<SipMessage> {
    const earlier = this.unclaimed.find(match);
    if (earlier) {
      this.unclaimed = this.unclaimed.filter((m) => m !== earlier);
      return Promise.resolve(earlier);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for a SIP message')),
        timeoutMs,
      );
      this.waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  response(status: number, method = 'INVITE', timeoutMs?: number): Promise<SipResponse> {
    return this.next(
      (m) =>
        m.kind === 'response' && m.status === status && m.headers.get('cseq')!.endsWith(method),
      timeoutMs,
    ) as Promise<SipResponse>;
  }

  request(method: string, timeoutMs?: number): Promise<SipRequest> {
    return this.next(
      (m) => m.kind === 'request' && m.method === method,
      timeoutMs,
    ) as Promise<SipRequest>;
  }

  reply(
    request: SipRequest,
    status: number,
    options: Parameters<typeof createResponse>[2] = {},
  ): SipResponse {
    const response = createResponse(request, status, options);
    const via = request.headers.getAll('via')[0]!;
    const port = Number(/:(\d+)/.exec(via.split(' ')[1]!)![1]);
    this.send(response, port);
    return response;
  }

  close(): void {
    this.socket.close();
  }
}

export interface CallLeg {
  callId: string;
  fromTag: string;
  invite: SipRequest;
}

export function sdpOffer(rtpPort: number, formats = '0 8 101', direction = 'sendrecv'): string {
  return [
    'v=0',
    `o=peer 1 1 IN IP4 127.0.0.1`,
    's=-',
    'c=IN IP4 127.0.0.1',
    't=0 0',
    `m=audio ${rtpPort} RTP/AVP ${formats}`,
    'a=rtpmap:101 telephone-event/8000',
    'a=fmtp:101 0-15',
    'a=ptime:20',
    `a=${direction}`,
    '',
  ].join('\r\n');
}

/** An INVITE from the peer to the gateway's number `to`. */
export function invite(input: {
  peerPort: number;
  to: string;
  from?: string;
  body?: string;
  headers?: [string, string][];
  callId?: string;
}): CallLeg {
  const callId = input.callId ?? `${hex(8)}@127.0.0.1`;
  const fromTag = hex(4);
  const headers = new SipHeaders()
    .append('via', `SIP/2.0/UDP 127.0.0.1:${input.peerPort};branch=z9hG4bK${hex(6)};rport`)
    .append('max-forwards', '70')
    .append('from', `<sip:${input.from ?? '+919876543210'}@127.0.0.1>;tag=${fromTag}`)
    .append('to', `<sip:${input.to}@127.0.0.1>`)
    .append('call-id', callId)
    .append('cseq', '1 INVITE')
    .append('contact', `<sip:peer@127.0.0.1:${input.peerPort}>`);
  for (const [name, value] of input.headers ?? []) headers.append(name, value);
  if (input.body !== undefined) headers.append('content-type', 'application/sdp');
  return {
    callId,
    fromTag,
    invite: {
      kind: 'request',
      method: 'INVITE',
      uri: `sip:${input.to}@127.0.0.1`,
      headers,
      body: Buffer.from(input.body ?? ''),
    },
  };
}

/** An in-dialog request from the peer, after the gateway's 2xx. */
export function inDialog(
  leg: CallLeg,
  ok: SipResponse,
  method: string,
  cseq: number,
  peerPort: number,
  body?: string,
): SipRequest {
  const headers = new SipHeaders()
    .append('via', `SIP/2.0/UDP 127.0.0.1:${peerPort};branch=z9hG4bK${hex(6)};rport`)
    .append('max-forwards', '70')
    .append('from', leg.invite.headers.get('from')!)
    .append('to', ok.headers.get('to')!)
    .append('call-id', leg.callId)
    .append('cseq', `${cseq} ${method}`);
  if (body !== undefined) headers.append('content-type', 'application/sdp');
  const contact = /<([^>]+)>/.exec(ok.headers.get('contact') ?? '')![1]!;
  return { kind: 'request', method, uri: contact, headers, body: Buffer.from(body ?? '') };
}

/** CANCEL for the peer's INVITE: same branch, same CSeq number. */
export function cancelOf(leg: CallLeg): SipRequest {
  const headers = new SipHeaders();
  for (const name of ['via', 'max-forwards', 'from', 'to', 'call-id'])
    headers.append(name, leg.invite.headers.get(name)!);
  headers.append('cseq', '1 CANCEL');
  return {
    kind: 'request',
    method: 'CANCEL',
    uri: leg.invite.uri,
    headers,
    body: new Uint8Array(),
  };
}

/** An ACK: for a non-2xx final it reuses the INVITE's Via (branch); for a 2xx it gets its own. */
export function ackFor(
  leg: CallLeg,
  response: SipResponse,
  viaFromInvite = false,
  cseq = 1,
): SipRequest {
  const headers = new SipHeaders()
    .append(
      'via',
      viaFromInvite
        ? leg.invite.headers.get('via')!
        : `SIP/2.0/UDP 127.0.0.1;branch=z9hG4bK${hex(6)}`,
    )
    .append('max-forwards', '70')
    .append('from', leg.invite.headers.get('from')!)
    .append('to', response.headers.get('to')!)
    .append('call-id', leg.callId)
    .append('cseq', `${cseq} ACK`);
  return { kind: 'request', method: 'ACK', uri: leg.invite.uri, headers, body: new Uint8Array() };
}

/** An RTP endpoint on 127.0.0.1 that records what it receives and sends 20 ms frames. */
export class RtpPeer {
  readonly packets: RtpPacket[] = [];
  private seq = 1000;
  private ts = 0;
  private constructor(private readonly socket: Socket) {
    socket.on('message', (data) => {
      const packet = parseRtp(data);
      if (packet) this.packets.push(packet);
    });
  }

  static async open(): Promise<RtpPeer> {
    const socket = createSocket('udp4');
    await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
    return new RtpPeer(socket);
  }

  get port(): number {
    return this.socket.address().port;
  }

  send(
    port: number,
    payloadType: number,
    payload: Uint8Array,
    marker = false,
    timestamp?: number,
  ): void {
    this.seq = (this.seq + 1) & 0xffff;
    this.ts += 160;
    this.socket.send(
      serializeRtp({
        marker,
        payloadType,
        sequence: this.seq,
        timestamp: timestamp ?? this.ts,
        ssrc: 0x5151,
        payload,
      }),
      port,
      '127.0.0.1',
    );
  }

  close(): void {
    this.socket.close();
  }
}

/** The RTP port in an SDP body. */
export function mediaPort(message: SipMessage): number {
  return Number(/m=audio (\d+)/.exec(Buffer.from(message.body).toString())![1]);
}
