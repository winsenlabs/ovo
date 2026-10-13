import { describe, expect, it } from 'vitest';
import {
  DtmfReceiver,
  dtmfPackets,
  encodeTelephoneEvent,
  parseTelephoneEvent,
} from '../../src/rtp/dtmf4733.ts';
import { FRAME_SAMPLES, JitterBuffer } from '../../src/rtp/jitter.ts';
import { MediaLatch } from '../../src/rtp/latch.ts';
import { isRtcp, parseRtp, serializeRtp } from '../../src/rtp/packet.ts';
import { Pacer } from '../../src/rtp/pacer.ts';
import { RtcpReporter } from '../../src/rtp/rtcp.ts';
import { RtpSource } from '../../src/rtp/receiver.ts';
import { FakeClock } from '../support/fake-clock.ts';

const frame = (fill: number, length = FRAME_SAMPLES) => new Uint8Array(length).fill(fill);

describe('RTP packets (RFC 3550 §5.1)', () => {
  it('round-trips the fixed header and skips CSRCs, extensions and padding', () => {
    const bytes = serializeRtp({
      marker: true,
      payloadType: 8,
      sequence: 65535,
      timestamp: 2 ** 32 - 1,
      ssrc: 0xdeadbeef,
      payload: frame(1, 4),
    });
    const parsed = parseRtp(bytes)!;
    expect({ ...parsed, payload: [...parsed.payload] }).toEqual({
      marker: true,
      payloadType: 8,
      sequence: 65535,
      timestamp: 2 ** 32 - 1,
      ssrc: 0xdeadbeef,
      payload: [1, 1, 1, 1],
    });
    const fancy = Buffer.concat([
      Buffer.from([0x80 | 0x20 | 0x10 | 1, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3]),
      Buffer.from([0, 0, 0, 9]),
      Buffer.from([0xbe, 0xde, 0, 1, 1, 2, 3, 4]),
      Buffer.from([7, 7, 0, 2]),
    ]);
    expect([...parseRtp(fancy)!.payload]).toEqual([7, 7]);
    expect(parseRtp(Buffer.from([0x40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeUndefined();
    expect(parseRtp(Buffer.alloc(8))).toBeUndefined();
    expect(isRtcp(Buffer.from([0x80, 201, 0, 1, 0, 0, 0, 1]))).toBe(true);
    expect(parseRtp(Buffer.from([0x80, 200 & 0x7f, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeUndefined();
  });
});

describe('RTP receiver (RFC 3550 A.1, A.8)', () => {
  it('keeps a new source on probation until two packets in sequence', () => {
    const source = new RtpSource(1, 100);
    expect(source.update(100)).toBe(false);
    expect(source.update(101)).toBe(true);
    expect(source.update(102)).toBe(true);
    const restart = new RtpSource(1, 100);
    expect(restart.update(500)).toBe(false);
    expect(restart.update(501)).toBe(true);
  });

  it('extends the sequence across the 65535 roll-over and counts loss', () => {
    const source = new RtpSource(1, 65533);
    for (const seq of [65533, 65534, 65535, 0, 2]) source.update(seq);
    expect(source.highestSequence).toBe(65536 + 2);
    const stats = source.stats();
    // 65533 was the probation packet; 65534, 65535, 0 and 2 arrived, 1 is missing.
    expect(stats.expected).toBe(5);
    expect(stats.packets).toBe(4);
    expect(stats.lost).toBe(1);
    expect(source.extendedTimestamp(2 ** 32 - 160)).toBe(2 ** 32 - 160);
    expect(source.extendedTimestamp(0)).toBe(2 ** 32);
  });

  it('accepts a large jump only after two sequential packets (source restart)', () => {
    const source = new RtpSource(1, 10);
    source.update(10);
    source.update(11);
    expect(source.update(20_000)).toBe(false);
    expect(source.update(20_001)).toBe(true);
  });

  it('estimates interarrival jitter', () => {
    const source = new RtpSource(1, 0);
    let arrival = 0;
    for (let i = 0; i < 200; i += 1) {
      arrival += i % 2 ? 30 : 10;
      source.arrival(arrival, i * 160);
    }
    expect(source.jitterMs).toBeGreaterThan(5);
    expect(source.jitterMs).toBeLessThan(15);
  });
});

describe('jitter buffer', () => {
  it('prefills to the target, then plays in timestamp order with reordering', () => {
    const jitter = new JitterBuffer({ silence: 0xff, targetMs: 40, minMs: 40 });
    expect(jitter.pop().concealed).toBe(false);
    jitter.push(0, frame(1));
    jitter.push(320, frame(3));
    const first = jitter.pop();
    jitter.push(160, frame(2));
    const order = [first, jitter.pop(), jitter.pop()].map((f) => f.frame[0]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('drops duplicates and late packets and conceals gaps with codec silence', () => {
    const jitter = new JitterBuffer({ silence: 0xd5, targetMs: 40, minMs: 40 });
    jitter.push(0, frame(1));
    expect(jitter.push(0, frame(1))).toBe('duplicate');
    jitter.push(320, frame(3));
    expect(jitter.pop().frame[0]).toBe(1);
    const gap = jitter.pop();
    expect(gap.concealed).toBe(true);
    expect(gap.frame.every((b) => b === 0xd5)).toBe(true);
    expect(jitter.push(160, frame(2))).toBe('late');
    expect(jitter.pop().frame[0]).toBe(3);
    expect(jitter.stats).toMatchObject({ late: 1, duplicates: 1, concealedFrames: 1 });
  });

  it('reframes 10 ms and 30 ms packets into 20 ms frames', () => {
    const jitter = new JitterBuffer({ silence: 0xff, targetMs: 40, minMs: 40 });
    for (let i = 0; i < 6; i += 1) jitter.push(i * 80, frame(i + 1, 80));
    expect([...jitter.pop().frame.subarray(78, 82)]).toEqual([1, 1, 2, 2]);
    const thirty = new JitterBuffer({ silence: 0xff, targetMs: 40, minMs: 40 });
    for (let i = 0; i < 4; i += 1) thirty.push(i * 240, frame(i + 1, 240));
    const frames = [thirty.pop(), thirty.pop(), thirty.pop()];
    expect(frames.map((f) => [f.frame[0], f.frame[159]])).toEqual([
      [1, 1],
      [1, 2],
      [2, 2],
    ]);
  });

  it('survives random reorder, duplicates and loss without losing alignment (property)', () => {
    let state = 99;
    const rand = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const jitter = new JitterBuffer({ silence: 0xff, targetMs: 60 });
    const packets = Array.from({ length: 300 }, (_, i) => i).filter(() => rand() > 0.05);
    for (let i = 0; i < packets.length - 1; i += 1)
      if (rand() < 0.1) [packets[i], packets[i + 1]] = [packets[i + 1]!, packets[i]!];
    const out: number[] = [];
    for (const index of packets) {
      jitter.push(index * 160, frame(index % 200));
      if (rand() < 0.05) jitter.push(index * 160, frame(index % 200));
      out.push(jitter.pop().frame[0]!);
    }
    for (let i = 0; i < 10; i += 1) out.push(jitter.pop().frame[0]!);
    const played = out.filter((b) => b !== 0xff);
    for (let i = 1; i < played.length; i += 1)
      expect(played[i]! > played[i - 1]! || played[i] === 0).toBe(true);
    expect(jitter.stats.duplicates).toBeGreaterThan(0);
  });
});

describe('pacer', () => {
  it('emits one tick per 20 ms against the start time, so timer lateness does not accumulate', () => {
    const clock = new FakeClock(0);
    let ticks = 0;
    const pacer = new Pacer(clock, () => (ticks += 1));
    pacer.begin();
    clock.advance(1_000);
    expect(ticks).toBe(50);
    expect(pacer.count).toBe(50);
    pacer.stop();
    clock.advance(1_000);
    expect(ticks).toBe(50);
  });

  it('catches up a few ticks after a stall and skips the rest', () => {
    let now = 0;
    const timers: { at: number; fn: () => void }[] = [];
    const clock = {
      now: () => now,
      monotonic: () => now,
      setTimeout: (fn: () => void, ms: number) => {
        timers.push({ at: now + ms, fn });
        return () => undefined;
      },
    };
    let ticks = 0;
    const pacer = new Pacer(clock, () => (ticks += 1));
    pacer.begin();
    now = 200; // the event loop stalled for 200 ms
    timers.shift()!.fn();
    expect(ticks).toBe(5);
    expect(pacer.skippedTicks).toBe(5);
    expect(pacer.maxDriftMs).toBe(180);
  });
});

describe('RFC 4733 telephone-events', () => {
  it('emits one digit per event, deduplicating the end retransmissions', () => {
    const receiver = new DtmfReceiver();
    const digits: string[] = [];
    for (const [ts, packets] of [
      [1000, dtmfPackets('5', 120)],
      [3000, dtmfPackets('#', 60)],
    ] as const)
      for (const packet of packets) {
        const event = receiver.receive(ts, packet.payload);
        if (event) digits.push(`${event.digit}:${event.durationMs}`);
      }
    expect(digits).toEqual(['5:120', '#:60']);
  });

  it('encodes the event layout and marks only the first packet', () => {
    const packets = dtmfPackets('A', 120);
    expect(packets[0]!.marker).toBe(true);
    expect(packets.slice(1).every((p) => !p.marker)).toBe(true);
    expect(packets.filter((p) => parseTelephoneEvent(p.payload)!.end)).toHaveLength(3);
    expect(
      parseTelephoneEvent(
        encodeTelephoneEvent({ event: 11, end: true, volume: 10, duration: 960 }),
      ),
    ).toEqual({
      event: 11,
      end: true,
      volume: 10,
      duration: 960,
    });
    expect(() => dtmfPackets('x', 100)).toThrow(RangeError);
  });
});

describe('latching (RTP Bleed mitigation)', () => {
  const signalled = { address: '203.0.113.5', port: 20000 };
  const inTrunk = (address: string) => address.startsWith('203.0.113.');

  it('moves to a new port inside the trunk media CIDRs after two in-sequence packets', () => {
    const latch = new MediaLatch(signalled, inTrunk);
    const nat = { address: '203.0.113.9', port: 31000 };
    expect(latch.accept(nat, { ssrc: 1, sequence: 10 }, true)).toBe(true);
    expect(latch.destination).toEqual(signalled);
    latch.accept(nat, { ssrc: 1, sequence: 11 }, true);
    expect(latch.destination).toEqual(nat);
    expect(latch.latches).toBe(1);
  });

  it('ignores media from outside the signalled address and the trunk CIDRs', () => {
    const latch = new MediaLatch(signalled, inTrunk);
    const attacker = { address: '192.0.2.66', port: 20000 };
    expect(latch.accept(attacker, { ssrc: 9, sequence: 1 }, true)).toBe(false);
    expect(latch.accept(attacker, { ssrc: 9, sequence: 2 }, true)).toBe(false);
    expect(latch.destination).toEqual(signalled);
    expect(latch.ignored).toBe(2);
  });

  it('does not latch on a different SSRC or a gap', () => {
    const latch = new MediaLatch(signalled, inTrunk);
    const other = { address: '203.0.113.5', port: 20002 };
    latch.accept(other, { ssrc: 1, sequence: 10 }, true);
    latch.accept(other, { ssrc: 2, sequence: 11 }, true);
    latch.accept(other, { ssrc: 2, sequence: 13 }, true);
    expect(latch.destination).toEqual(signalled);
  });
});

describe('RTCP (RFC 3550 §6)', () => {
  it('builds RR or SR with SDES, reports loss per interval and reads the peer report', () => {
    const reporter = new RtcpReporter(0x1234, 'ovo@test');
    const rr = reporter.build(0, undefined, {
      ssrc: 7,
      expected: 100,
      received: 90,
      highestSequence: 99,
      jitter: 12,
    });
    expect(rr[1]).toBe(201);
    expect(rr[8 + 4]).toBe(Math.floor((10 * 256) / 100));
    const sr = reporter.build(
      5000,
      { ssrc: 0x1234, packets: 250, octets: 40000, rtpTimestamp: 1 },
      undefined,
    );
    expect(sr[1]).toBe(200);
    expect(sr.readUInt32BE(20)).toBe(250);
    const peer = new RtcpReporter(9, 'peer').build(0, undefined, {
      ssrc: 0x1234,
      expected: 10,
      received: 5,
      highestSequence: 9,
      jitter: 3,
    });
    expect(reporter.observe(peer, 0)).toEqual({
      fractionLost: 128 / 256,
      cumulativeLost: 5,
      jitter: 3,
    });
    const bye = reporter.bye(0, undefined, undefined);
    expect(bye.subarray(bye.length - 8)[1]).toBe(203);
  });
});
