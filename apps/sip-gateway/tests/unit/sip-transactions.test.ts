import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMERS, type Flow } from '../../src/sip/flow.ts';
import {
  SipHeaders,
  type SipMessage,
  type SipRequest,
  type SipResponse,
} from '../../src/sip/message.ts';
import { createResponse } from '../../src/sip/serialize.ts';
import type { ServerTransaction } from '../../src/sip/server-transaction.ts';
import { TransactionLayer, clientKey, serverKey } from '../../src/sip/transactions.ts';
import { FakeClock } from '../support/fake-clock.ts';

const UDP: Flow = { transport: 'udp', address: '127.0.0.1', port: 5070 };
const TCP: Flow = { transport: 'tcp', address: '127.0.0.1', port: 5070, connectionId: 1 };

function request(method: string, branch = 'z9hG4bKone', toTag?: string): SipRequest {
  const headers = new SipHeaders()
    .append('via', `SIP/2.0/UDP 127.0.0.1:5070;branch=${branch}`)
    .append('from', '<sip:a@127.0.0.1>;tag=f1')
    .append('to', `<sip:b@127.0.0.1>${toTag ? `;tag=${toTag}` : ''}`)
    .append('call-id', 'call-1')
    .append('cseq', `1 ${method}`);
  return { kind: 'request', method, uri: 'sip:b@127.0.0.1', headers, body: new Uint8Array() };
}

function response(req: SipRequest, status: number): SipResponse {
  return createResponse(req, status, { toTag: 't1' });
}

function harness() {
  const clock = new FakeClock(0);
  const sent: { message: SipMessage; at: number }[] = [];
  const tu = {
    requests: [] as SipRequest[],
    txs: [] as (ServerTransaction | undefined)[],
    strays: [] as SipResponse[],
  };
  const layer = new TransactionLayer(
    { send: (message) => sent.push({ message, at: clock.now() }), clock, timers: DEFAULT_TIMERS },
    {
      onRequest: (req, _flow, tx) => {
        tu.requests.push(req);
        tu.txs.push(tx);
      },
      onStrayResponse: (res) => tu.strays.push(res),
    },
  );
  return { clock, sent, tu, layer };
}

const times = (sent: { message: SipMessage; at: number }[], filter: (m: SipMessage) => boolean) =>
  sent.filter(({ message }) => filter(message)).map(({ at }) => at);

describe('transaction keys', () => {
  it('matches ACK and CANCEL to their INVITE branch', () => {
    expect(serverKey(request('ACK'))).toBe(serverKey(request('INVITE')));
    expect(serverKey(request('CANCEL'))).toBe('z9hG4bKone|127.0.0.1:5070|CANCEL');
    expect(serverKey(request('INVITE', 'rfc2543-branch'))).toBeUndefined();
    expect(clientKey(request('INVITE'))).toBe('z9hG4bKone|INVITE');
  });
});

describe('client INVITE transaction (RFC 3261 §17.1.1, RFC 6026)', () => {
  it('retransmits on Timer A doubling, then gives up at Timer B (64·T1)', () => {
    const { clock, sent, layer } = harness();
    let timedOut = 0;
    layer.request(request('INVITE'), UDP, {
      onResponse: () => undefined,
      onTimeout: () => (timedOut += 1),
    });
    clock.advance(40_000);
    expect(times(sent, (m) => m.kind === 'request')).toEqual([
      0, 500, 1500, 3500, 7500, 15500, 31500,
    ]);
    expect(timedOut).toBe(1);
    expect(layer.counts.client).toBe(0);
  });

  it('stops retransmitting on a provisional and ACKs a non-2xx final itself', () => {
    const { clock, sent, layer } = harness();
    const seen: number[] = [];
    const invite = request('INVITE');
    layer.request(invite, UDP, {
      onResponse: (r) => seen.push(r.status),
      onTimeout: () => undefined,
    });
    layer.receive(response(invite, 180), UDP);
    clock.advance(10_000);
    expect(times(sent, (m) => m.kind === 'request' && m.method === 'INVITE')).toEqual([0]);
    layer.receive(response(invite, 486), UDP);
    layer.receive(response(invite, 486), UDP);
    expect(seen).toEqual([180, 486]);
    const acks = sent.filter(
      ({ message }) => message.kind === 'request' && message.method === 'ACK',
    );
    expect(acks).toHaveLength(2);
    expect(acks[0]!.message.headers.get('cseq')).toBe('1 ACK');
    expect(acks[0]!.message.headers.get('to')).toContain('tag=t1');
    clock.advance(32_000);
    expect(layer.counts.client).toBe(0);
  });

  it('passes every 2xx to the TU in Accepted and terminates on Timer M', () => {
    const { clock, layer } = harness();
    const seen: string[] = [];
    const invite = request('INVITE');
    layer.request(invite, UDP, {
      onResponse: (r) => seen.push(`${r.status}`),
      onTimeout: () => undefined,
    });
    layer.receive(response(invite, 200), UDP);
    layer.receive(response(invite, 200), UDP);
    expect(seen).toEqual(['200', '200']);
    clock.advance(32_000);
    expect(layer.counts.client).toBe(0);
  });

  it('keeps a ringing INVITE past 64·T1: Timer B bounds Calling only (§17.1.1.2)', () => {
    const { clock, layer } = harness();
    let timedOut = 0;
    const invite = request('INVITE');
    const tx = layer.request(invite, UDP, {
      onResponse: () => undefined,
      onTimeout: () => (timedOut += 1),
    });
    clock.advance(1_000);
    layer.receive(response(invite, 180), UDP);
    clock.advance(60_000);
    expect(timedOut).toBe(0);
    expect(tx.state).toBe('proceeding');
    expect(layer.counts.client).toBe(1);
  });

  it('times out a CANCELled INVITE 64·T1 after the CANCEL when no final arrives (§9.1)', () => {
    const { clock, layer } = harness();
    let timedOut = 0;
    const invite = request('INVITE');
    const tx = layer.request(invite, UDP, {
      onResponse: () => undefined,
      onTimeout: () => (timedOut += 1),
    });
    layer.receive(response(invite, 180), UDP);
    clock.advance(45_000);
    tx.cancelled();
    clock.advance(31_999);
    expect(timedOut).toBe(0);
    clock.advance(1);
    expect(timedOut).toBe(1);
    expect(layer.counts.client).toBe(0);
  });

  it('does not retransmit over TCP', () => {
    const { clock, sent, layer } = harness();
    layer.request(request('INVITE'), TCP, {
      onResponse: () => undefined,
      onTimeout: () => undefined,
    });
    clock.advance(40_000);
    expect(sent).toHaveLength(1);
  });
});

describe('client non-INVITE transaction', () => {
  it('doubles Timer E up to T2 and times out at Timer F', () => {
    const { clock, sent, layer } = harness();
    let timedOut = false;
    layer.request(request('BYE'), UDP, {
      onResponse: () => undefined,
      onTimeout: () => (timedOut = true),
    });
    clock.advance(33_000);
    expect(times(sent, () => true)).toEqual([
      0, 500, 1500, 3500, 7500, 11500, 15500, 19500, 23500, 27500, 31500,
    ]);
    expect(timedOut).toBe(true);
  });

  it('still times out at Timer F once proceeding', () => {
    const { clock, layer } = harness();
    let timedOut = false;
    const bye = request('BYE');
    layer.request(bye, UDP, { onResponse: () => undefined, onTimeout: () => (timedOut = true) });
    layer.receive(response(bye, 100), UDP);
    clock.advance(32_000);
    expect(timedOut).toBe(true);
  });

  it('retransmits at T2 once proceeding and stops on a final', () => {
    const { clock, sent, layer } = harness();
    const bye = request('BYE');
    layer.request(bye, UDP, { onResponse: () => undefined, onTimeout: () => undefined });
    clock.advance(600);
    layer.receive(response(bye, 100), UDP);
    clock.advance(1000);
    layer.receive(response(bye, 200), UDP);
    clock.advance(20_000);
    expect(times(sent, () => true)).toEqual([0, 500, 1500]);
    expect(layer.counts.client).toBe(0);
  });
});

describe('server INVITE transaction', () => {
  it('absorbs retransmissions, resending the last provisional', () => {
    const { sent, tu, layer } = harness();
    const invite = request('INVITE');
    layer.receive(invite, UDP);
    expect(tu.requests).toHaveLength(1);
    const tx = layer.inviteFor(request('CANCEL'))!;
    tx.respond(response(invite, 100));
    layer.receive(invite, UDP);
    expect(tu.requests).toHaveLength(1);
    expect(sent.map(({ message }) => (message as SipResponse).status)).toEqual([100, 100]);
  });

  it('retransmits a non-2xx final on Timer G until the ACK, then absorbs ACKs for Timer I', () => {
    const { clock, sent, tu, layer } = harness();
    const invite = request('INVITE');
    layer.receive(invite, UDP);
    const tx = layer.inviteFor(request('CANCEL'))!;
    tx.respond(response(invite, 486));
    clock.advance(3_600);
    expect(times(sent, () => true)).toEqual([0, 500, 1500, 3500]);
    layer.receive(request('ACK'), UDP);
    expect(tx.state).toBe('confirmed');
    expect(tu.requests).toHaveLength(1);
    clock.advance(10_000);
    expect(times(sent, () => true)).toHaveLength(4);
    expect(tx.state).toBe('terminated');
  });

  it('gives up on Timer H without an ACK', () => {
    const { clock, layer } = harness();
    const invite = request('INVITE');
    layer.receive(invite, UDP);
    const tx = layer.inviteFor(request('CANCEL'))!;
    let reason: string | undefined;
    const previous = tx.onTerminated;
    tx.onTerminated = (why) => {
      reason = why;
      previous?.(why);
    };
    tx.respond(response(invite, 503));
    clock.advance(32_001);
    expect(reason).toBe('ack-timeout');
    expect(layer.counts.server).toBe(0);
  });

  it('enters Accepted on 2xx (RFC 6026): INVITE retransmissions are absorbed for Timer L', () => {
    const { clock, sent, tu, layer } = harness();
    const invite = request('INVITE');
    layer.receive(invite, UDP);
    const tx = layer.inviteFor(request('CANCEL'))!;
    tx.respond(response(invite, 200));
    layer.receive(invite, UDP);
    expect(tu.requests).toHaveLength(1);
    expect(sent).toHaveLength(1);
    // The 2xx ACK has its own branch and reaches the TU.
    layer.receive(request('ACK', 'z9hG4bKack', 't1'), UDP);
    expect(tu.requests.map((r) => r.method)).toEqual(['INVITE', 'ACK']);
    clock.advance(32_000);
    expect(layer.counts.server).toBe(0);
  });
});

describe('server non-INVITE transaction', () => {
  it('replays its final for retransmissions until Timer J', () => {
    const { clock, sent, tu, layer } = harness();
    const bye = request('BYE', 'z9hG4bKbye', 't1');
    layer.receive(bye, UDP);
    tu.txs[0]!.respond(response(bye, 200));
    layer.receive(bye, UDP);
    expect(tu.requests).toHaveLength(1);
    expect(sent.map(({ message }) => (message as SipResponse).status)).toEqual([200, 200]);
    clock.advance(32_000);
    expect(layer.counts.server).toBe(0);
    // After Timer J the same branch is a new request again.
    layer.receive(bye, UDP);
    expect(tu.requests).toHaveLength(2);
  });

  it('terminates at once over TCP', () => {
    const { clock, tu, layer } = harness();
    const bye = request('BYE', 'z9hG4bKbye', 't1');
    layer.receive(bye, TCP);
    tu.txs[0]!.respond(response(bye, 200));
    clock.advance(0);
    expect(layer.counts.server).toBe(0);
  });
});
