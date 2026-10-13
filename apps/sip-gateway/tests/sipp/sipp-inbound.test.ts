import { createSocket } from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { dtmfPackets } from '../../src/rtp/dtmf4733.ts';
import { serializeRtp } from '../../src/rtp/packet.ts';
import { DID, sleep, startHarness, type Harness } from '../support/harness.ts';
import { SIPP, evidence, runSipp, tracedMessages, type SippOptions } from '../support/sipp.ts';

// W11 §17.3 scenarios with SIPp as the trunk's UAC, against a gateway on 127.0.0.1:15060.
const SIP_PORT = 15060;
const GATEWAY = `127.0.0.1:${SIP_PORT}`;
const UAC: SippOptions = { localPort: 15061, mediaPort: 16000, remote: GATEWAY };
const ENV = {
  OVO_SIP_PORT: String(SIP_PORT),
  OVO_SIP_RTP_PORT_MIN: '41000',
  OVO_SIP_RTP_PORT_MAX: '41199',
};

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function gateway(options: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  harness = await startHarness({
    ...options,
    media: { ...options.media, ...evidence() },
    env: { ...ENV, ...options.env },
  });
  return harness;
}

const seqs = (h: Harness) => (h.media.framesIn('media') as { seq: number }[]).map((f) => f.seq);
const increasing = (values: number[]) => values.every((v, i) => i === 0 || v > values[i - 1]!);

async function expectPass(run: ReturnType<typeof runSipp>) {
  const result = await run.done;
  if (result.code !== 0)
    throw new Error(`sipp exit ${result.code}\n${result.errors}\n${result.output}`);
  return result;
}

describe.skipIf(!SIPP)('SIPp UAC scenarios (sipp on loopback)', { timeout: 120_000 }, () => {
  it.each(['u1', 't1'] as const)(
    '#1 uac-basic over %s: 100/180/200, RTP both ways, BYE',
    async (transport) => {
      const h = await gateway();
      const result = await expectPass(
        runSipp('uac-basic', { ...UAC, transport, rtpEcho: true, pauseMs: 5000 }),
      );
      expect(
        tracedMessages(result.messages, /^SIP\/2\.0 (100|180|200)/).length,
      ).toBeGreaterThanOrEqual(3);
      const answer = tracedMessages(result.messages, /^SIP\/2\.0 200 OK/)[0]!;
      expect(answer).toMatch(/m=audio \d+ RTP\/AVP 0 101/);
      expect(h.media.framesIn('start')).toHaveLength(1);
      expect(seqs(h).length).toBeGreaterThan(150);
      expect(increasing(seqs(h))).toBe(true);
      await h.media.waitFor(() => h.media.framesIn('stop')[0]);
      expect(h.media.framesIn('stop')[0]).toEqual({ event: 'stop', reason: 'caller-hangup' });
      const completed = await h.media.waitFor(() =>
        h.media.statuses.find((s) => s.state === 'completed'),
      );
      expect((completed.payload as { rtp: { packetsIn: number } }).rtp.packetsIn).toBeGreaterThan(
        150,
      );
    },
  );

  it('#2 uac-pcma: answers PCMA, the media socket carries μ-law', async () => {
    const h = await gateway({ media: { echoAfterMs: 200 } });
    const result = await expectPass(
      runSipp('uac-basic', { ...UAC, rtpEcho: true, keys: { formats: '8 101' }, pauseMs: 3000 }),
    );
    expect(tracedMessages(result.messages, /^SIP\/2\.0 200 OK/)[0]).toMatch(
      /m=audio \d+ RTP\/AVP 8 101/,
    );
    // A-law silence (0xD5) arrives as μ-law 0xFE: the gateway transcoded it.
    const payloads = (h.media.framesIn('media') as { payload: string }[]).map((f) =>
      Buffer.from(f.payload, 'base64'),
    );
    expect(payloads.some((p) => p.includes(0xfe))).toBe(true);
    expect(payloads.some((p) => p.includes(0xd5))).toBe(false);
  });

  it('#3 uac-nocodec: G.729 only is refused with 488', async () => {
    const h = await gateway();
    await expectPass(runSipp('uac-nocodec', { ...UAC, keys: { formats: '18' } }));
    expect(h.media.inbound).toHaveLength(0);
  });

  it('#4 uac-cancel: CANCEL after 180 gets 200 and 487; no media socket', async () => {
    const h = await gateway({
      media: {
        decide: () => ({
          kind: 'wait',
          pauseSeconds: 5,
          retryUrl: 'https://ovo.example.test/carriers/sip/binding-1/inbound',
        }),
      },
    });
    await expectPass(runSipp('uac-cancel', UAC));
    expect(h.media.sockets).toHaveLength(0);
  });

  it('#5 uac-dtmf: one dtmf frame per RFC 4733 event', async () => {
    const h = await gateway();
    const run = runSipp('uac-basic', { ...UAC, pauseMs: 3000 });
    await h.media.waitFor(() => h.media.framesIn('start')[0], 10_000);
    const port = h.running.gateway.registry.all()[0]!.localMedia!.port;
    const socket = createSocket('udp4');
    let seq = 100;
    for (const [digit, ts] of [
      ['1', 8000],
      ['9', 16000],
      ['#', 24000],
    ] as const)
      for (const packet of dtmfPackets(digit, 100)) {
        socket.send(
          serializeRtp({
            marker: packet.marker,
            payloadType: 101,
            sequence: seq++,
            timestamp: ts,
            ssrc: 77,
            payload: packet.payload,
          }),
          port,
          '127.0.0.1',
        );
        await sleep(5);
      }
    await expectPass(run);
    socket.close();
    expect(h.media.framesIn('dtmf').map((f) => (f as { digit: string }).digit)).toEqual([
      '1',
      '9',
      '#',
    ]);
  });

  it('#6 uac-hold: sendonly → recvonly, then sendrecv; o= version moves; upstream keeps flowing', async () => {
    const h = await gateway();
    const result = await expectPass(runSipp('uac-hold', UAC));
    const versions = tracedMessages(result.messages, /^SIP\/2\.0 200 OK/)
      .map((m) => /o=ovo \d+ (\d+) /.exec(m)?.[1])
      .filter(Boolean)
      .map(Number);
    expect(versions).toHaveLength(3);
    expect(versions[1]).toBe(versions[0]! + 1);
    expect(versions[2]).toBe(versions[1]! + 1);
    expect(seqs(h).length).toBeGreaterThan(100);
  });

  // RTP is echoed so the 30 s media timeout cannot end the call first.
  it('#7 uac-timer: Session-Expires 90 refresher=uac without refresh → our BYE at ~60 s', async () => {
    const h = await gateway();
    const started = Date.now();
    await expectPass(runSipp('uac-timer', { ...UAC, rtpEcho: true, timeoutSec: 100 }));
    const elapsed = (Date.now() - started) / 1000;
    expect(elapsed).toBeGreaterThanOrEqual(59);
    expect(elapsed).toBeLessThanOrEqual(68);
    const completed = await h.media.waitFor(() =>
      h.media.statuses.find((s) => s.state === 'completed'),
    );
    expect(completed.payload).toMatchObject({ endReason: 'session_expired' });
  });

  it('#8 uac-timer-small: Session-Expires 60 → 422 with Min-SE 90', async () => {
    await gateway();
    await expectPass(runSipp('uac-timer-small', UAC));
  });

  it.each(['u1', 't1'] as const)(
    '#9 options over %s: 200, then 503 while draining',
    async (transport) => {
      const h = await gateway();
      await expectPass(runSipp('options', { ...UAC, transport }));
      const call = runSipp('uac-basic', {
        ...UAC,
        localPort: 15063,
        mediaPort: 16010,
        pauseMs: 3000,
      });
      await h.media.waitFor(() => h.media.framesIn('start')[0], 10_000);
      const draining = h.running.stop();
      await expectPass(runSipp('options-draining', { ...UAC, transport }));
      await expectPass(call);
      await draining;
    },
  );

  it('#10 unknown-source: a gateway whose allow-list excludes 127.0.0.1 never answers', async () => {
    const h = await gateway({
      trunks: [
        {
          id: 'far',
          carrierId: 'sip',
          bindingId: 'b',
          signallingCidrs: ['192.0.2.0/24'],
          inbound: { enabled: true, numbers: [DID] },
        },
      ],
    });
    await expectPass(runSipp('uac-unanswered', UAC));
    expect(h.running.gateway.counters.drops.unknown_source).toBeGreaterThanOrEqual(1);
  });

  it.each(['u1', 't1'] as const)(
    '#11 malformed over %s: no Via is dropped, a bad Content-Length gets 400; health stays up',
    async (transport) => {
      const h = await gateway();
      await expectPass(runSipp('uac-no-via', { ...UAC, transport }));
      if (transport === 'u1') await expectPass(runSipp('uac-bad-length', { ...UAC, transport }));
      expect(h.running.gateway.counters.drops.malformed).toBeGreaterThanOrEqual(1);
      const health = await fetch(`http://127.0.0.1:${h.running.ports.health}/health`);
      expect(health.status).toBe(200);
      await expectPass(runSipp('uac-basic', { ...UAC, transport, pauseMs: 500 }));
    },
  );

  it('#11 malformed over TCP: a 70 KB message closes the connection, the gateway keeps serving', async () => {
    const h = await gateway();
    const { connect } = await import('node:net');
    const socket = connect({ host: '127.0.0.1', port: SIP_PORT });
    socket.on('error', () => undefined);
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write(
      `OPTIONS sip:x@127.0.0.1 SIP/2.0\r\nContent-Length: ${70 * 1024}\r\n\r\n${'a'.repeat(70 * 1024)}`,
    );
    await new Promise((resolve) => socket.once('close', resolve));
    expect(h.running.gateway.counters.drops.oversize).toBeGreaterThanOrEqual(1);
    await expectPass(runSipp('options', { ...UAC, transport: 't1' }));
  });

  it('#12 uac-lossy: -lost 10 still converges through retransmissions', async () => {
    const h = await gateway();
    await expectPass(
      runSipp('uac-basic', { ...UAC, calls: 5, rate: 2, pauseMs: 1000, extra: ['-lost', '10'] }),
    );
    await h.media.waitFor(() => h.running.gateway.registry.size === 0, 10_000);
  });

  it('#15 uac-wait-bye: marks after their audio, then our BYE once playout drains', async () => {
    const h = await gateway();
    const run = runSipp('uac-wait-bye', UAC);
    await h.media.waitFor(() => h.media.framesIn('start')[0], 10_000);
    h.media.send({ event: 'media', payload: Buffer.alloc(1600, 0x33).toString('base64') });
    h.media.send({ event: 'mark', name: 'a' });
    h.media.send({ event: 'media', payload: Buffer.alloc(1600, 0x33).toString('base64') });
    h.media.send({ event: 'mark', name: 'b' });
    h.media.send({ event: 'terminate' });
    await expectPass(run);
    expect(h.media.framesIn('mark')).toEqual([
      { event: 'mark', name: 'a' },
      { event: 'mark', name: 'b' },
    ]);
    const completed = await h.media.waitFor(() =>
      h.media.statuses.find((s) => s.state === 'completed'),
    );
    expect(completed.payload).toMatchObject({ endReason: 'terminate' });
  });

  it('#16 load: -r 5 -l 4 -m 100 -rtp_echo, nothing leaks', async () => {
    const h = await gateway();
    await expectPass(
      runSipp('uac-basic', {
        ...UAC,
        calls: 100,
        limit: 4,
        rate: 5,
        pauseMs: 1000,
        rtpEcho: true,
        timeoutSec: 90,
      }),
    );
    await h.media.waitFor(() => h.running.gateway.registry.size === 0, 10_000);
    const pool = h.running.gateway.pool.stats();
    expect(pool.inUse).toBe(0);
    expect(pool.free + pool.quarantined).toBe(100);
    expect(h.media.statuses.filter((s) => s.state === 'completed')).toHaveLength(100);
  });

  it('#17 uac-resume: the media socket drops mid-call, the call survives on a new stream', async () => {
    const h = await gateway();
    const run = runSipp('uac-basic', { ...UAC, pauseMs: 4000, rtpEcho: true });
    await h.media.waitFor(() => h.media.framesIn('media').length > 50, 10_000);
    h.media.drop();
    await expectPass(run);
    const starts = h.media.framesIn('start') as { routeParams: Record<string, string> }[];
    expect(starts.map((s) => s.routeParams.rt)).toEqual(['rt-1', 'rt-2']);
    expect(increasing(seqs(h))).toBe(true);
    expect(h.media.resumes).toHaveLength(1);
  });

  it('#20 uac-wait: two wait decisions hold the ringing, then connect', async () => {
    const h = await gateway({
      media: {
        decide: (request) =>
          request.retry < 2
            ? {
                kind: 'wait',
                pauseSeconds: 1,
                retryUrl: `https://ovo.example.test/carriers/sip/binding-1/inbound?n=${request.retry}`,
              }
            : undefined!,
      },
    });
    await expectPass(runSipp('uac-basic', { ...UAC, pauseMs: 1000 }));
    expect(h.media.inbound.map((r) => r.retry)).toEqual([0, 1, 2]);
  });
});
