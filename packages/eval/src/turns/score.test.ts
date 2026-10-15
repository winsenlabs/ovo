import { describe, expect, it } from 'vitest';
import type { Thought } from './gold.ts';
import { aggregate, percentile, scoreReplay } from './score.ts';

const thought = (id: string, start: number, end: number, reply = true): Thought => ({
  id,
  start,
  end,
  text: id,
  runs: 1,
  reply,
});

describe('turn scorer', () => {
  const thoughts = [
    thought('t1', 1000, 5000),
    thought('t2', 10_000, 12_000, false),
    thought('t3', 20_000, 24_000),
    thought('t4', 30_000, 31_000),
  ];

  it('classifies each endpoint against the thought it falls in', () => {
    const score = scoreReplay(
      {
        endpoints: [
          { at: 3000, text: 'half of t1' }, // false: t1 still going
          { at: 5600, text: 't1' }, // t1 answered 600 ms after it ended
          { at: 7000, text: 't1 again' }, // duplicate
          { at: 12_500, text: 'noise' }, // spurious: t2 expects no reply
          { at: 22_000, text: 'half of t3' }, // false
          { at: 23_000, text: 'more of t3' }, // false
          { at: 24_800, text: 't3' }, // 800 ms
          // t4: never answered (missed)
        ],
      },
      thoughts,
    );
    expect(score).toMatchObject({
      thoughts: 3,
      endpoints: 7,
      falseEndpoints: 3,
      splitThoughts: 2,
      missed: 1,
      spurious: 1,
      duplicates: 1,
      latencies: [600, 800],
      slow: 0,
    });
    expect(score.splitRate).toBeCloseTo(2 / 3);
    expect(score.requestsPerThought).toBeCloseTo(7 / 3);
    expect(score.detail.map((d) => d.false)).toEqual([1, 0, 2, 0]);
  });

  it('counts a reply that comes only after the next thought started as missed, and false for that one', () => {
    const score = scoreReplay({ endpoints: [{ at: 21_000, text: 'late' }] }, thoughts);
    expect(score.detail[0]!.latency).toBeUndefined();
    expect(score.detail[2]!.false).toBe(1);
  });

  it('counts endpoints before any thought as spurious, and slow ones', () => {
    const score = scoreReplay(
      {
        endpoints: [
          { at: 500, text: 'noise' },
          { at: 7000, text: 't1 late' },
        ],
      },
      thoughts,
    );
    expect(score.spurious).toBe(1);
    expect(score.slow).toBe(1);
  });

  it('sums calls and takes percentiles over every thought', () => {
    const a = scoreReplay({ endpoints: [{ at: 5100, text: '' }] }, thoughts);
    const b = scoreReplay(
      {
        endpoints: [
          { at: 5900, text: '' },
          { at: 24_300, text: '' },
        ],
      },
      thoughts,
    );
    const total = aggregate([a, b]);
    expect(total).toMatchObject({
      thoughts: 6,
      endpoints: 3,
      missed: 3,
      latencies: [100, 900, 300],
    });
    expect(total.p50).toBe(300);
    expect(percentile([], 50)).toBeUndefined();
    expect(percentile([1, 2, 3, 4], 90)).toBe(4);
  });
});
