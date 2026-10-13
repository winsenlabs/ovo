import { alawToMulaw, mulawToAlaw } from '@winsendotai/ovo-audio';
import { decodeBase64 } from '@winsendotai/ovo-sip-carrier-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { dtmfPackets } from '../../src/rtp/dtmf4733.ts';
import type { SipResponse } from '../../src/sip/message.ts';
import { serialize } from '../../src/sip/serialize.ts';
import { DID, startHarness, sleep, type Harness } from '../support/harness.ts';
import {
  RtpPeer,
  SipPeer,
  ackFor,
  cancelOf,
  inDialog,
  invite,
  mediaPort,
  sdpOffer,
} from '../support/sip-peer.ts';

let harness: Harness | undefined;
const peers: { close(): void }[] = [];

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.close();
  await harness?.close();
  harness = undefined;
});

async function setup(options: Parameters<typeof startHarness>[0] = {}) {
  harness = await startHarness(options);
  const sip = await SipPeer.open();
  const rtp = await RtpPeer.open();
  peers.push(sip, rtp);
  return { h: harness, sip, rtp };
}

/** INVITE → 100/180/200 → ACK; returns the leg and the 200. */
async function answeredCall(
  sip: SipPeer,
  rtp: RtpPeer,
  h: Harness,
  formats = '0 8 101',
  headers: [string, string][] = [],
) {
  const leg = invite({ peerPort: sip.port, to: DID, body: sdpOffer(rtp.port, formats), headers });
  sip.send(leg.invite, h.sipPort);
  const ok = await sip.response(200);
  sip.send(ackFor(leg, ok), h.sipPort);
  return { leg, ok };
}

describe('inbound calls (W11 §3 inbound path)', () => {
  it('rings, asks the host, opens the media socket, answers and streams both ways until BYE', async () => {
    const { h, sip, rtp } = await setup({ media: { echoAfterMs: 200 } });
    const { leg, ok } = await answeredCall(sip, rtp, h, '0 8 101', [['X-Account', '12345']]);
    expect(
      sip.received
        .filter((m) => m.kind === 'response')
        .map((m) => (m as SipResponse).status)
        .slice(0, 3),
    ).toEqual([100, 180, 200]);
    const answer = Buffer.from(ok.body).toString();
    expect(answer).toContain('m=audio');
    expect(answer).toMatch(/m=audio \d+ RTP\/AVP 0 101/);
    expect(ok.headers.get('supported')).toBe('timer');
    expect(h.media.inbound[0]).toMatchObject({
      callId: leg.callId,
      trunkId: 'loop',
      from: '+919876543210',
      to: DID,
      headers: { 'X-Account': '12345' },
      retry: 0,
    });
    const start = await h.media.waitFor(() => h.media.framesIn('start')[0]);
    expect(start).toMatchObject({
      callId: leg.callId,
      routeParams: { sid: 'session-1', rt: 'rt-1' },
    });
    const gwPort = mediaPort(ok);
    for (let i = 0; i < 25; i += 1) {
      rtp.send(gwPort, 0, new Uint8Array(160).fill(0x10 + (i % 8)));
      await sleep(20);
    }
    await h.media.waitFor(() => h.media.framesIn('media').length >= 20);
    const media = h.media.framesIn('media') as { seq: number; tsMs: number; payload: string }[];
    media.forEach((frame, i) => {
      expect(frame.seq).toBe(i + 1);
      expect(frame.tsMs).toBe(20 * i);
      expect(decodeBase64(frame.payload).byteLength).toBe(160);
    });
    // Caller audio reached the gateway and its echo came back as PCMU RTP.
    await h.media.waitFor(() => rtp.packets.some((p) => p.payload[0] === 0x10));
    expect(rtp.packets.every((p) => p.payloadType === 0)).toBe(true);
    const bye = inDialog(leg, ok, 'BYE', 2, sip.port);
    sip.send(bye, h.sipPort);
    await sip.response(200, 'BYE');
    await h.media.waitFor(() => h.media.framesIn('stop')[0]);
    expect(h.media.framesIn('stop')[0]).toEqual({ event: 'stop', reason: 'caller-hangup' });
    const completed = await h.media.waitFor(() =>
      h.media.statuses.find((s) => s.state === 'completed'),
    );
    expect(h.media.statuses.map((s) => s.state)).toEqual(['in_progress', 'completed']);
    expect(completed.payload).toMatchObject({ endReason: 'remote_bye', codec: 'PCMU' });
    expect((completed.payload as { rtp: { packetsIn: number } }).rtp.packetsIn).toBeGreaterThan(15);
    expect(h.running.gateway.registry.size).toBe(0);
    // Logs carry the last four digits of a number, never the whole number.
    expect(JSON.stringify(h.logs)).not.toContain('9876543210');
  });

  it('answers PCMA and transcodes: μ-law upstream, A-law back to the trunk', async () => {
    const { h, sip, rtp } = await setup({ media: { echoAfterMs: 50 } });
    const { ok } = await answeredCall(sip, rtp, h, '8 101');
    expect(Buffer.from(ok.body).toString()).toMatch(/m=audio \d+ RTP\/AVP 8 101/);
    const alaw = new Uint8Array(160).fill(0x2a);
    for (let i = 0; i < 10; i += 1) {
      rtp.send(mediaPort(ok), 8, alaw);
      await sleep(20);
    }
    const mulaw = alawToMulaw(alaw);
    await h.media.waitFor(() =>
      (h.media.framesIn('media') as { payload: string }[]).some(
        (f) => decodeBase64(f.payload)[0] === mulaw[0],
      ),
    );
    await h.media.waitFor(() => rtp.packets.some((p) => p.payload[0] === mulawToAlaw(mulaw)[0]));
    expect(rtp.packets.every((p) => p.payloadType === 8)).toBe(true);
  });

  it.each<
    [string, { formats?: string; to?: string; headers?: [string, string][]; body?: string }, number]
  >([
    ['no common codec', { formats: '18 101' }, 488],
    ['an unknown number', { to: '+918000000099' }, 404],
    [
      'a session interval under Min-SE',
      { headers: [['Session-Expires', '60']] as [string, string][] },
      422,
    ],
    ['Require: 100rel', { headers: [['Require', '100rel']] as [string, string][] }, 420],
    [
      'an SRTP offer',
      {
        body: 'v=0\r\no=x 1 1 IN IP4 127.0.0.1\r\ns=-\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio 4000 RTP/SAVP 0\r\n',
      },
      488,
    ],
  ])('refuses %s', async (_name, change, status) => {
    const { h, sip, rtp } = await setup();
    const leg = invite({
      peerPort: sip.port,
      to: change.to ?? DID,
      body: change.body ?? sdpOffer(rtp.port, change.formats),
      headers: change.headers ?? [],
    });
    sip.send(leg.invite, h.sipPort);
    const final = await sip.response(status);
    if (status === 422) expect(final.headers.get('min-se')).toBe('90');
    if (status === 420) expect(final.headers.get('unsupported')).toBe('100rel');
    sip.send(ackFor(leg, final, true), h.sipPort);
    expect(h.media.inbound).toHaveLength(0);
    expect(h.media.sockets).toHaveLength(0);
  });

  it('CANCEL while the host decides: 200 for the CANCEL, 487 for the INVITE, no media socket', async () => {
    const { h, sip, rtp } = await setup({
      media: {
        decide: (request) => ({
          kind: 'wait',
          pauseSeconds: 2,
          retryUrl: `https://ovo.example.test/carriers/sip/binding-1/inbound?retry=${request.retry + 1}`,
        }),
      },
    });
    const leg = invite({ peerPort: sip.port, to: DID, body: sdpOffer(rtp.port) });
    sip.send(leg.invite, h.sipPort);
    await sip.response(180);
    sip.send(cancelOf(leg), h.sipPort);
    await sip.response(200, 'CANCEL');
    const terminated = await sip.response(487);
    sip.send(ackFor(leg, terminated, true), h.sipPort);
    await sleep(2_500);
    expect(h.media.inbound).toHaveLength(1);
    expect(h.media.sockets).toHaveLength(0);
    expect(h.running.gateway.registry.size).toBe(0);
  });

  it('follows wait decisions (ringing held) and then connects', async () => {
    const { h, sip, rtp } = await setup({
      media: {
        decide: (request) =>
          request.retry < 2
            ? {
                kind: 'wait',
                pauseSeconds: 0.2,
                retryUrl: `https://ovo.example.test/carriers/sip/binding-1/inbound?attempt=${request.retry + 1}`,
              }
            : undefined!,
      },
    });
    await answeredCall(sip, rtp, h);
    expect(h.media.inbound.map((r) => r.retry)).toEqual([0, 1, 2]);
  });

  it('refuses an INVITE the host rejects, with the mapped final', async () => {
    const { h, sip, rtp } = await setup({ media: { decide: () => ({ kind: 'busy' }) } });
    const leg = invite({ peerPort: sip.port, to: DID, body: sdpOffer(rtp.port) });
    sip.send(leg.invite, h.sipPort);
    await sip.response(486);
    expect(h.media.sockets).toHaveLength(0);
  });

  it('forwards one DTMF per RFC 4733 event and per INFO dtmf-relay', async () => {
    const { h, sip, rtp } = await setup();
    const { leg, ok } = await answeredCall(sip, rtp, h);
    await h.media.waitFor(() => h.media.framesIn('start')[0]);
    for (const packet of dtmfPackets('7', 120))
      rtp.send(mediaPort(ok), 101, packet.payload, packet.marker, 8000);
    await h.media.waitFor(() => h.media.framesIn('dtmf')[0]);
    const info = inDialog(leg, ok, 'INFO', 2, sip.port);
    info.headers.append('content-type', 'application/dtmf-relay');
    info.body = Buffer.from('Signal=#\r\nDuration=160\r\n');
    sip.send(info, h.sipPort);
    await sip.response(200, 'INFO');
    const digits = await h.media.waitFor(() =>
      h.media.framesIn('dtmf').length >= 2 ? h.media.framesIn('dtmf') : undefined,
    );
    expect(digits).toEqual([
      { event: 'dtmf', digit: '7', durationMs: 120 },
      { event: 'dtmf', digit: '#', durationMs: 160 },
    ]);
  });

  it('plays marks after their audio, flushes them on clear, and BYEs after terminate drains', async () => {
    const { h, sip, rtp } = await setup();
    await answeredCall(sip, rtp, h);
    await h.media.waitFor(() => h.media.framesIn('start')[0]);
    const audio = Buffer.alloc(800, 0x33).toString('base64');
    h.media.send({ event: 'media', payload: audio });
    h.media.send({ event: 'mark', name: 'm1' });
    await h.media.waitFor(() => h.media.framesIn('mark')[0]);
    const markAt = h.media.frames.find((f) => f.dir === 'in' && f.frame.event === 'mark')!.at;
    const sentAt = h.media.frames.find((f) => f.dir === 'out' && f.frame.event === 'mark')!.at;
    expect(markAt - sentAt).toBeGreaterThanOrEqual(80);
    h.media.send({ event: 'media', payload: Buffer.alloc(16_000, 0x33).toString('base64') });
    h.media.send({ event: 'mark', name: 'm2' });
    h.media.send({ event: 'mark', name: 'm3' });
    h.media.send({ event: 'clear' });
    await h.media.waitFor(() => h.media.framesIn('cleared')[0]);
    const events = h.media.frames.filter(
      (f) => f.dir === 'in' && ['mark', 'cleared'].includes(f.frame.event as string),
    );
    expect(events.map((f) => (f.frame as { name?: string }).name ?? f.frame.event)).toEqual([
      'm1',
      'm2',
      'm3',
      'cleared',
    ]);
    h.media.send({ event: 'media', payload: audio });
    h.media.send({ event: 'mark', name: 'last' });
    h.media.send({ event: 'terminate' });
    const bye = await sip.request('BYE');
    expect(h.media.framesIn('mark').at(-1)).toEqual({ event: 'mark', name: 'last' });
    expect(bye.headers.get('reason')).toContain('cause=16');
    sip.reply(bye, 200);
    const completed = await h.media.waitFor(() =>
      h.media.statuses.find((s) => s.state === 'completed'),
    );
    expect(completed.payload).toMatchObject({ endReason: 'terminate' });
  });

  it('resumes after the media socket drops: new stream, new route params, seq keeps counting', async () => {
    const { h, sip, rtp } = await setup();
    const { ok } = await answeredCall(sip, rtp, h);
    await h.media.waitFor(() => h.media.framesIn('media').length >= 5);
    h.media.drop();
    await h.media.waitFor(() => h.media.framesIn('start').length >= 2);
    const [first, second] = h.media.framesIn('start') as {
      streamId: string;
      routeParams: Record<string, string>;
    }[];
    expect(second!.streamId).not.toBe(first!.streamId);
    expect(second!.routeParams).toEqual({ sid: 'session-1', rt: 'rt-2' });
    await h.media.waitFor(() => h.media.framesIn('media').length >= 20);
    const seqs = (h.media.framesIn('media') as { seq: number }[]).map((f) => f.seq);
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    expect(h.media.resumes).toHaveLength(1);
    expect(h.media.statuses.some((s) => s.state === 'completed')).toBe(false);
    expect(mediaPort(ok)).toBeGreaterThan(0);
  });

  it('handles hold and unhold re-INVITEs with o= versioning', async () => {
    const { h, sip, rtp } = await setup();
    const { leg, ok } = await answeredCall(sip, rtp, h);
    const version = (r: SipResponse) =>
      Number(/^o=ovo \d+ (\d+) /m.exec(Buffer.from(r.body).toString())![1]);
    const hold = inDialog(leg, ok, 'INVITE', 2, sip.port, sdpOffer(rtp.port, '0 101', 'sendonly'));
    sip.send(hold, h.sipPort);
    const held = (await sip.next(
      (m) => m.kind === 'response' && m.status === 200 && m.headers.get('cseq') === '2 INVITE',
    )) as SipResponse;
    expect(Buffer.from(held.body).toString()).toContain('a=recvonly');
    expect(version(held)).toBe(version(ok) + 1);
    sip.send(ackFor(leg, held, false, 2), h.sipPort);
    const resume = inDialog(leg, ok, 'INVITE', 3, sip.port, sdpOffer(rtp.port, '0 101'));
    sip.send(resume, h.sipPort);
    const resumed = (await sip.next(
      (m) => m.kind === 'response' && m.status === 200 && m.headers.get('cseq') === '3 INVITE',
    )) as SipResponse;
    expect(Buffer.from(resumed.body).toString()).toContain('a=sendrecv');
    expect(version(resumed)).toBe(version(ok) + 2);
    sip.send(ackFor(leg, resumed, false, 3), h.sipPort);
    // Upstream silence keeps flowing on hold, so the gateway idle clock never fires.
    const before = h.media.framesIn('media').length;
    await sleep(200);
    expect(h.media.framesIn('media').length).toBeGreaterThan(before + 5);
  });

  it('answers OPTIONS, and 503 to OPTIONS and new INVITEs while draining; live calls finish', async () => {
    const { h, sip, rtp } = await setup();
    const { leg, ok } = await answeredCall(sip, rtp, h);
    const options = invite({ peerPort: sip.port, to: DID });
    options.invite.method = 'OPTIONS';
    options.invite.headers.set('cseq', '1 OPTIONS');
    sip.send(options.invite, h.sipPort);
    expect((await sip.response(200, 'OPTIONS')).headers.get('allow')).toContain('INVITE');
    const draining = h.running.stop();
    await sleep(50);
    const again = invite({ peerPort: sip.port, to: DID });
    again.invite.method = 'OPTIONS';
    again.invite.headers.set('cseq', '1 OPTIONS');
    sip.send(again.invite, h.sipPort);
    await sip.response(503, 'OPTIONS');
    const late = invite({ peerPort: sip.port, to: DID, body: sdpOffer(rtp.port) });
    sip.send(late.invite, h.sipPort);
    expect((await sip.response(503)).headers.get('retry-after')).toBe('30');
    sip.send(inDialog(leg, ok, 'BYE', 2, sip.port), h.sipPort);
    await sip.response(200, 'BYE');
    await draining;
  });

  it('drops requests from sources outside every trunk without answering', async () => {
    const { h, sip, rtp } = await setup({
      trunks: [
        {
          id: 'elsewhere',
          carrierId: 'sip',
          bindingId: 'b',
          signallingCidrs: ['192.0.2.0/24'],
          inbound: { enabled: true, numbers: [DID] },
        },
      ],
    });
    const leg = invite({ peerPort: sip.port, to: DID, body: sdpOffer(rtp.port) });
    sip.send(leg.invite, h.sipPort);
    await expect(sip.response(100, 'INVITE', 500)).rejects.toThrow('timed out');
    h.running.gateway.drops.flush();
    expect(h.running.gateway.counters.drops.unknown_source).toBe(1);
  });

  it('answers malformed requests from a trunk with 400 or drops them, and keeps serving', async () => {
    const { h, sip, rtp } = await setup();
    const leg = invite({ peerPort: sip.port, to: DID, body: sdpOffer(rtp.port) });
    const text = Buffer.from(
      serialize(leg.invite)
        .toString('latin1')
        .replace(/Content-Length: \d+/, 'Content-Length: x'),
      'latin1',
    );
    sip.sendRaw(text, h.sipPort);
    await sip.response(400);
    sip.sendRaw(Buffer.from('garbage\r\n\r\n'), h.sipPort);
    sip.sendRaw(Buffer.alloc(70 * 1024, 0x41).subarray(0, 4097), h.sipPort);
    await sleep(100);
    expect(h.running.gateway.counters.drops.malformed).toBeGreaterThanOrEqual(2);
    await answeredCall(sip, rtp, h);
  });
});
