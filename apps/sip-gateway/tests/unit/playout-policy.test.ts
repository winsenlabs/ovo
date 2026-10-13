import { describe, expect, it } from 'vitest';
import { FRAME_BYTES, MAX_QUEUED_BYTES, PlayoutQueue } from '../../src/media/playout.ts';
import { allowedDestination, normaliseNumber, userOf } from '../../src/policy/numbers.ts';
import { KeyedBuckets, TokenBucket, sourceLimits } from '../../src/policy/ratelimit.ts';
import { FakeClock } from '../support/fake-clock.ts';

const audio = (bytes: number, fill = 1) => new Uint8Array(bytes).fill(fill);

describe('playout queue (§4.5)', () => {
  it('reframes into 160-byte frames and reports a mark right after the audio before it', () => {
    const queue = new PlayoutQueue();
    queue.pushAudio(audio(400, 7));
    queue.pushMark('m1');
    queue.pushAudio(audio(160, 8));
    const ticks = [queue.pop(), queue.pop(), queue.pop(), queue.pop(), queue.pop()];
    expect(ticks.map((t) => t.frame?.length)).toEqual([
      FRAME_BYTES,
      FRAME_BYTES,
      FRAME_BYTES,
      FRAME_BYTES,
      undefined,
    ]);
    expect(ticks.map((t) => t.marks)).toEqual([[], [], ['m1'], [], []]);
    // The partial frame before the mark is padded with μ-law silence, never with later audio.
    expect([...ticks[2]!.frame!.subarray(78, 82)]).toEqual([7, 7, 0xff, 0xff]);
    expect(ticks[3]!.frame![0]).toBe(8);
  });

  it('reports a mark queued with no audio before it on the next tick', () => {
    const queue = new PlayoutQueue();
    queue.pushMark('first');
    queue.pushMark('second');
    expect(queue.pop()).toEqual({ marks: ['first', 'second'] });
    expect(queue.empty).toBe(true);
  });

  it('clear drops the audio and returns every pending mark in order', () => {
    const queue = new PlayoutQueue();
    queue.pushAudio(audio(1600));
    queue.pushMark('a');
    queue.pushAudio(audio(1600));
    queue.pushMark('b');
    queue.pop();
    expect(queue.clear()).toEqual(['a', 'b']);
    expect(queue.queuedBytes).toBe(0);
    expect(queue.pop()).toEqual({ marks: [] });
  });

  it('refuses audio over the 30 s cap', () => {
    const queue = new PlayoutQueue();
    expect(queue.pushAudio(audio(MAX_QUEUED_BYTES))).toBe(true);
    expect(queue.queuedMs).toBe(30_000);
    expect(queue.pushAudio(audio(1))).toBe(false);
  });
});

describe('number normalisation (§4.7, IN)', () => {
  it.each([
    ['+919876543210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['9876543210', '+919876543210'],
    ['+91 98765-43210', '+919876543210'],
    ['+14155550100', undefined],
    ['0012345', undefined],
    ['0987654321', undefined],
    ['+910876543210', undefined],
  ])('%s → %s', (raw, expected) => {
    expect(normaliseNumber(raw, 'IN')).toBe(expected);
  });

  it('keeps strict E.164 for E164 trunks and reads URI users', () => {
    expect(normaliseNumber('+14155550100', 'E164')).toBe('+14155550100');
    expect(normaliseNumber('14155550100', 'E164')).toBeUndefined();
    expect(userOf('"X" <sip:+919876543210@198.51.100.7;user=phone>;tag=1')).toBe('+919876543210');
    expect(userOf('<tel:+919876543210>')).toBe('+919876543210');
    expect(userOf('sip:198.51.100.7')).toBeUndefined();
  });

  it('allows outbound destinations only under the country prefixes', () => {
    expect(allowedDestination('+919876543210', ['+91'])).toBe(true);
    expect(allowedDestination('+14155550100', ['+91'])).toBe(false);
    expect(allowedDestination('919876543210', ['+91'])).toBe(false);
  });
});

describe('token buckets', () => {
  it('refills at the rate up to the burst', () => {
    const clock = new FakeClock(0);
    const bucket = new TokenBucket(5, 10, clock);
    let taken = 0;
    while (bucket.take()) taken += 1;
    expect(taken).toBe(10);
    clock.advance(200);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
    clock.advance(10_000);
    taken = 0;
    while (bucket.take()) taken += 1;
    expect(taken).toBe(10);
  });

  it('keys buckets per source, forgets idle keys and caps the map', () => {
    const clock = new FakeClock(0);
    const buckets = new KeyedBuckets(1, 1, clock, 2);
    expect(buckets.take('a')).toBe(true);
    expect(buckets.take('a')).toBe(false);
    expect(buckets.take('b')).toBe(true);
    expect(buckets.take('c')).toBe(false);
    clock.advance(61_000);
    expect(buckets.take('c')).toBe(true);
  });

  it('applies the §4.7 per-source defaults (INVITE 5/s burst 10)', () => {
    const limits = sourceLimits(new FakeClock(0));
    let invites = 0;
    while (limits.invite.take('198.51.100.7')) invites += 1;
    expect(invites).toBe(10);
  });
});
