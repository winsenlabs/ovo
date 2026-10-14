import { describe, expect, it } from 'vitest';
import { goldThoughts } from './gold.ts';
import type { Timeline } from './timeline.ts';

function timeline(
  runs: [number, number][],
  words: [number, string][] = [],
  agent: [number, number, string?][] = [],
): Timeline {
  return {
    call: 'test',
    label: 'test',
    durationMs: 60_000,
    transcripts: words.map(([at, text], index) => ({
      at,
      type: 'transcript',
      seg: String(index),
      text,
      final: true,
    })),
    agent: agent.map(([start, stop, kind = 'response']) => ({
      start,
      stop,
      kind,
      text: 'Sure.',
      state: 'completed',
    })),
    live: [],
    vad: {
      source: 'audio',
      events: runs.flatMap(([start, stop]) => [
        { at: start, type: 'vad.start' as const },
        { at: stop, type: 'vad.stop' as const },
      ]),
    },
  };
}

describe('turn gold', () => {
  it('groups speech runs while the caller holds the floor, and splits on a long gap', () => {
    const thoughts = goldThoughts(
      timeline(
        [
          [1000, 2000],
          [2900, 4000], // 1.1 s after the voice ended: same thought
          [8000, 9000], // 4.2 s: a new one
        ],
        [
          [2300, 'We are going to'],
          [4300, 'Vienna.'],
          [9400, 'What about Prague?'],
        ],
      ),
    );
    expect(
      thoughts.map(({ start, end, runs, text, reply }) => ({ start, end, runs, text, reply })),
    ).toEqual([
      { start: 1000, end: 3800, runs: 2, text: 'We are going to Vienna.', reply: true },
      { start: 8000, end: 8800, runs: 1, text: 'What about Prague?', reply: true },
    ]);
  });

  it('ends a thought where a reply of the agent started in the gap (not a filler)', () => {
    const runs: [number, number][] = [
      [1000, 2000],
      [3000, 4000],
    ];
    expect(goldThoughts(timeline(runs, [], [[2500, 2900]]))).toHaveLength(2);
    expect(goldThoughts(timeline(runs, [], [[2500, 2900, 'acknowledgment']]))).toHaveLength(1);
  });

  it('expects no reply for a backchannel over the agent, or no words; "Yes." in silence answers', () => {
    const thoughts = goldThoughts(
      timeline(
        [
          [1000, 1500],
          [10_000, 10_400],
          [20_000, 20_400],
        ],
        [
          [1700, 'haan'],
          [10_600, 'Yes.'],
        ],
        [[500, 3000]],
      ),
    );
    expect(thoughts.map((t) => t.reply)).toEqual([false, true, false]);
  });

  it('applies overrides: voiced transcripts, forced splits and merges, no-reply notes', () => {
    const base = timeline(
      [
        [1000, 2000],
        [4800, 6000],
      ],
      [
        [3000, 'Of January.'],
        [6300, 'Hello'],
      ],
    );
    // "Of January." had no VAD run; voiced, it joins the first thought (gap < 2 s on both sides).
    const voiced = goldThoughts(base, { voiced: [{ at: 3000, note: 'soft' }] });
    expect(voiced.map((t) => t.runs)).toEqual([3]);
    const merged = goldThoughts(base, { merge: [{ at: 3000, note: 'one thought' }] });
    expect(merged).toHaveLength(1);
    const split = goldThoughts(
      timeline([
        [1000, 2000],
        [2500, 3000],
      ]),
      { split: [{ at: 2200, note: 'two' }] },
    );
    expect(split).toHaveLength(2);
    const quiet = goldThoughts(base, { noReply: [{ at: 5500, note: 'background talker' }] });
    expect(quiet[1]).toMatchObject({ reply: false, note: 'background talker' });
  });
});
