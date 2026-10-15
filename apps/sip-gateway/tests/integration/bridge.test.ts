import {
  alawToMulaw,
  concatBytes,
  mulawToPcm16,
  pcm16ToAlaw,
  pcm16ToMulaw,
  toneShare,
} from '@winsendotai/ovo-audio';
import { afterEach, describe, expect, it } from 'vitest';
import { SipHeaders, type SipRequest } from '../../src/sip/message.ts';
import { DID, FROM, loopbackTrunk, sleep, startHarness } from '../support/harness.ts';
import {
  RtpPeer,
  SipPeer,
  ackFor,
  inDialog,
  invite,
  mediaPort,
  sdpOffer,
} from '../support/sip-peer.ts';

// Stretch S1: a trunk that refuses REFER (`refer.mode: bridge`). The gateway keeps the caller's leg
// (SipPeer "caller"), dials the destination on the trunk's outbound proxy (SipPeer "dest") and
// relays RTP between them.
let harness: Awaited<ReturnType<typeof startHarness>> | undefined;
const peers: { close(): void }[] = [];

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.close();
  await harness?.close();
  harness = undefined;
});

const SIP_TARGET = {
  kind: 'sip',
  uri: 'sip:desk@queue.acd.example.net',
  headers: { 'X-OVO-Ticket': 't-1', 'X-OVO-Language': 'en IN' },
} as const;
const PHONE = { kind: 'phone', e164: '+919000000042' } as const;
let seq = 0;

async function setup(
  options: {
    refer?: Record<string, unknown>;
    outbound?: Record<string, unknown>;
    env?: Record<string, string>;
  } = {},
) {
  const dest = await SipPeer.open();
  const caller = await SipPeer.open();
  const callerRtp = await RtpPeer.open();
  const destRtp = await RtpPeer.open();
  peers.push(dest, caller, callerRtp, destRtp);
  const h = await startHarness({
    env: { OVO_SIP_BRIDGE_ENABLED: 'true', OVO_SIP_REFER_TIMEOUT_MS: '2000', ...options.env },
    trunks: [
      loopbackTrunk({
        refer: {
          enabled: true,
          mode: 'bridge',
          allowedHosts: ['.acd.example.net'],
          ...options.refer,
        },
        outbound: {
          enabled: true,
          proxy: `sip:127.0.0.1:${dest.port}`,
          fromNumbers: [FROM],
          auth: 'ip',
          ...options.outbound,
        },
      }),
    ],
  });
  harness = h;
  const leg = invite({ peerPort: caller.port, to: DID, body: sdpOffer(callerRtp.port, '0 101') });
  caller.send(leg.invite, h.sipPort);
  const ok = await caller.response(200);
  caller.send(ackFor(leg, ok), h.sipPort);
  await h.media.waitFor(() => h.media.framesIn('start')[0]);
  const handoff = (target: unknown, requestId = `b-${(seq += 1)}`) =>
    h.control('POST', '/v1/calls/handoff', { carrierCallId: leg.callId, requestId, target });
  return { h, dest, caller, callerRtp, destRtp, leg, ok, handoff };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

/** The destination rings, answers with PCMA (so the relay must transcode) and gets its ACK. */
async function answer(f: Fixture, ring = true): Promise<SipRequest> {
  const dialed = await f.dest.request('INVITE');
  if (ring) f.dest.reply(dialed, 180, { toTag: 'dest' });
  f.dest.reply(dialed, 200, {
    toTag: 'dest',
    headers: [
      ['Contact', `<sip:dest@127.0.0.1:${f.dest.port}>`],
      ['Content-Type', 'application/sdp'],
    ],
    body: Buffer.from(sdpOffer(f.destRtp.port, '8 101')),
  });
  await f.dest.request('ACK');
  return dialed;
}

/** A BYE from the destination, which is the UAS of the gateway's INVITE. */
function byeFromDest(f: Fixture, dialed: SipRequest): SipRequest {
  const headers = new SipHeaders()
    .append('via', `SIP/2.0/UDP 127.0.0.1:${f.dest.port};branch=z9hG4bKdest${(seq += 1)}`)
    .append('max-forwards', '70')
    .append('from', `${dialed.headers.get('to')!};tag=dest`)
    .append('to', dialed.headers.get('from')!)
    .append('call-id', dialed.headers.get('call-id')!)
    .append('cseq', '1 BYE');
  const contact = /<([^>]+)>/.exec(dialed.headers.get('contact')!)![1]!;
  return { kind: 'request', method: 'BYE', uri: contact, headers, body: new Uint8Array() };
}

const tone = (freq: number, offset: number): Int16Array => {
  const out = new Int16Array(160);
  for (let i = 0; i < 160; i += 1)
    out[i] = Math.round(10_000 * Math.sin((2 * Math.PI * freq * (offset + i)) / 8000));
  return out;
};

describe('SIP bridge (stretch S1)', () => {
  it('dials the phone on the trunk proxy and relays audio both ways across PCMU and PCMA', async () => {
    const f = await setup();
    const pending = f.handoff(PHONE, 'b-main');
    const dialed = await answer(f);
    expect(dialed.uri).toBe(`sip:${PHONE.e164}@127.0.0.1:${f.dest.port}`);
    expect(dialed.headers.get('from')).toContain(FROM);
    expect(dialed.headers.get('x-ovo-ticket')).toBeUndefined();
    const reply = await pending;
    expect(reply.body.kind).toBe('confirmed');
    expect(reply.body.receiptId).toMatch(/^sip-bridge:[0-9a-f]{32}$/);

    // The worker's media socket is told, and both legs now count against the call limit.
    await f.h.media.waitFor(() => f.h.media.framesIn('stop')[0]);
    expect(f.h.media.framesIn('stop')[0]).toEqual({ event: 'stop', reason: 'transferred' });
    expect(f.h.running.gateway.registry.size).toBe(2);

    // The caller (PCMU) speaks 1000 Hz, the destination (PCMA) 1800 Hz.
    const callerPort = mediaPort(f.ok);
    const destPort = mediaPort(dialed);
    for (let i = 0; i < 100; i += 1) {
      f.callerRtp.send(callerPort, 0, pcm16ToMulaw(tone(1000, i * 160)));
      f.destRtp.send(destPort, 8, pcm16ToAlaw(tone(1800, i * 160)));
      await sleep(20);
    }
    const atDest = f.destRtp.packets.filter((p) => p.payloadType === 8).slice(25);
    const atCaller = f.callerRtp.packets.filter((p) => p.payloadType === 0).slice(25);
    expect(atDest.length).toBeGreaterThan(40);
    expect(atCaller.length).toBeGreaterThan(40);
    const destHears = mulawToPcm16(alawToMulaw(concatBytes(atDest.map((p) => p.payload))));
    const callerHears = mulawToPcm16(concatBytes(atCaller.map((p) => p.payload)));
    expect(toneShare(destHears, 8000, 1000)).toBeGreaterThan(0.9);
    expect(toneShare(destHears, 8000, 1800)).toBeLessThan(0.01);
    expect(toneShare(callerHears, 8000, 1800)).toBeGreaterThan(0.9);
    expect(toneShare(callerHears, 8000, 1000)).toBeLessThan(0.01);
  });

  it('the destination hanging up ends the caller too, and nothing is left behind', async () => {
    const f = await setup();
    const pending = f.handoff(PHONE);
    const dialed = await answer(f);
    await pending;
    f.dest.send(byeFromDest(f, dialed), f.h.sipPort);
    expect((await f.dest.response(200, 'BYE')).status).toBe(200);
    f.caller.reply(await f.caller.request('BYE'), 200);
    await f.h.media.waitFor(() => f.h.running.gateway.registry.size === 0, 5_000);
    const completed = await f.h.media.waitFor(() =>
      f.h.media.statuses.find((s) => s.state === 'completed'),
    );
    expect(completed.payload).toMatchObject({ endReason: 'bridge_peer_ended' });
    expect(f.h.running.gateway.pool.stats().inUse).toBe(0);
  });

  it('the caller hanging up ends the destination too', async () => {
    const f = await setup();
    const pending = f.handoff(PHONE);
    await answer(f);
    await pending;
    f.caller.send(inDialog(f.leg, f.ok, 'BYE', 2, f.caller.port), f.h.sipPort);
    expect((await f.caller.response(200, 'BYE')).status).toBe(200);
    f.dest.reply(await f.dest.request('BYE'), 200);
    await f.h.media.waitFor(() => f.h.running.gateway.registry.size === 0, 5_000);
    expect(f.h.running.gateway.pool.stats().inUse).toBe(0);
  });

  it('a SIP target is the Request-URI, routed via the proxy, with the context as real headers', async () => {
    const f = await setup();
    const pending = f.handoff(SIP_TARGET);
    const dialed = await answer(f);
    expect(dialed.uri).toBe('sip:desk@queue.acd.example.net');
    expect(dialed.headers.get('to')).toBe('<sip:desk@queue.acd.example.net>');
    expect(dialed.headers.get('x-ovo-ticket')).toBe('t-1');
    expect(dialed.headers.get('x-ovo-language')).toBe('en IN');
    expect((await pending).body.kind).toBe('confirmed');
  });

  it("a destination that refuses is a rejection and the caller stays on the worker's media socket", async () => {
    const f = await setup();
    const first = f.handoff(PHONE);
    const dialed = await f.dest.request('INVITE');
    f.dest.reply(dialed, 486, { toTag: 'dest' });
    expect((await first).body).toEqual({
      kind: 'rejected',
      reason: 'bridge_failed_sip_486',
      retryable: false,
    });
    expect(f.h.media.framesIn('stop')).toHaveLength(0);
    expect(f.h.running.gateway.registry.size).toBe(1);
    expect(f.h.running.gateway.pool.stats().inUse).toBe(1);
    // The slot is free: a second try goes through.
    const second = f.handoff(PHONE);
    await answer(f);
    expect((await second).body.kind).toBe('confirmed');
  });

  it('a 503 is retryable', async () => {
    const f = await setup();
    const pending = f.handoff(PHONE);
    f.dest.reply(await f.dest.request('INVITE'), 503, { toTag: 'dest' });
    expect((await pending).body).toEqual({
      kind: 'rejected',
      reason: 'bridge_failed_sip_503',
      retryable: true,
    });
  });

  it('no answer within the ring timeout cancels the dial and keeps the caller', async () => {
    const f = await setup();
    const started = Date.now();
    const pending = f.handoff(PHONE);
    const dialed = await f.dest.request('INVITE');
    f.dest.reply(dialed, 180, { toTag: 'dest' });
    expect((await pending).body).toMatchObject({
      kind: 'rejected',
      reason: 'bridge_failed_ring_timeout',
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    expect((await f.dest.request('CANCEL')).method).toBe('CANCEL');
    expect(f.h.media.framesIn('stop')).toHaveLength(0);
    await f.h.media.waitFor(() => f.h.running.gateway.registry.size === 1, 5_000);
  });

  it('the caller hanging up while the destination rings cancels the dial and frees every port', async () => {
    const f = await setup();
    const pending = f.handoff(PHONE);
    const dialed = await f.dest.request('INVITE');
    f.dest.reply(dialed, 180, { toTag: 'dest' });
    f.caller.send(inDialog(f.leg, f.ok, 'BYE', 2, f.caller.port), f.h.sipPort);
    await f.caller.response(200, 'BYE');
    expect((await pending).body).toMatchObject({ kind: 'rejected', reason: 'call_ended' });
    await f.dest.request('CANCEL');
    await f.h.media.waitFor(() => f.h.running.gateway.registry.size === 0, 5_000);
    expect(f.h.running.gateway.pool.stats().inUse).toBe(0);
  });

  it('refuses a second transfer while dialing, but joins a repeat of the same request', async () => {
    const f = await setup();
    const first = f.handoff(PHONE, 'b-one');
    await f.dest.request('INVITE');
    expect((await f.handoff(PHONE, 'b-two')).body).toEqual({
      kind: 'rejected',
      reason: 'refer_in_progress',
      retryable: true,
    });
    const repeat = f.handoff(PHONE, 'b-one');
    expect((await first).body).toMatchObject({ kind: 'rejected' });
    expect((await repeat).body).toEqual((await first).body);
  });

  describe('accounting against OVO_SIP_MAX_CALLS', () => {
    it('refuses when the second leg would not fit', async () => {
      const f = await setup({ env: { OVO_SIP_MAX_CALLS: '1' } });
      expect((await f.handoff(PHONE)).body).toEqual({
        kind: 'rejected',
        reason: 'bridge_at_capacity',
        retryable: true,
      });
      await sleep(100);
      expect(f.dest.received.some((m) => m.kind === 'request' && m.method === 'INVITE')).toBe(
        false,
      );
    });

    it('counts both legs while bridged: a third call is refused with 503, then fits again after teardown', async () => {
      const f = await setup({ env: { OVO_SIP_MAX_CALLS: '2' } });
      const pending = f.handoff(PHONE);
      const dialed = await answer(f);
      await pending;
      const other = await SipPeer.open();
      peers.push(other);
      const third = invite({ peerPort: other.port, to: DID, body: sdpOffer(40_000, '0 101') });
      other.send(third.invite, f.h.sipPort);
      expect((await other.next((m) => m.kind === 'response' && m.status >= 200)).kind).toBe(
        'response',
      );
      expect(other.received.some((m) => m.kind === 'response' && m.status === 503)).toBe(true);
      f.dest.send(byeFromDest(f, dialed), f.h.sipPort);
      f.caller.reply(await f.caller.request('BYE'), 200);
      await f.h.media.waitFor(() => f.h.running.gateway.registry.size === 0, 5_000);
    });
  });

  describe('policy, before anything is dialled', () => {
    const rejected = (reason: string, retryable = false) => ({
      kind: 'rejected',
      reason,
      retryable,
    });

    it('bridging is off unless OVO_SIP_BRIDGE_ENABLED is true', async () => {
      const f = await setup({ env: { OVO_SIP_BRIDGE_ENABLED: 'false' } });
      expect((await f.handoff(PHONE)).body).toEqual(rejected('bridge_not_enabled'));
    });

    it.each([
      [
        'a phone number outside the country allow-list',
        { kind: 'phone', e164: '+14155550123' },
        'destination_not_permitted',
      ],
      [
        'a host off the allow-list',
        { ...SIP_TARGET, uri: 'sip:x@evil.example.com' },
        'refer_host_not_allowed',
      ],
    ])('refuses %s', async (_what, target, reason) => {
      const f = await setup();
      expect((await f.handoff(target)).body).toEqual(rejected(reason));
    });

    it('needs a caller-ID the trunk and the gateway both permit', async () => {
      const f = await setup({ outbound: { fromNumbers: ['+918000000099'] } });
      expect((await f.handoff(PHONE)).body).toEqual(rejected('bridge_from_not_permitted'));
    });

    it('a trunk in refer mode never bridges, whatever the flag says', async () => {
      const f = await setup({
        refer: { mode: 'refer', phoneUriTemplate: 'sip:{e164}@sbc.example.net' },
      });
      const pending = f.handoff(PHONE);
      const refer = await f.caller.request('REFER');
      expect(refer.headers.get('refer-to')).toBe('<sip:+919000000042@sbc.example.net>');
      f.caller.reply(refer, 603);
      expect((await pending).body.kind).toBe('rejected');
      expect(f.dest.received).toEqual([]);
    });
  });
});
