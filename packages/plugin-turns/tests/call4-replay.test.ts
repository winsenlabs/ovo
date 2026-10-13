import { describe, expect, it } from 'vitest';
import { FakeClock } from '@winsendotai/ovo-conformance/drivers';
import { call4, runCall, SAID } from './call4-timeline.ts';
import { LIVE, MAYA, RECOMMENDED, replay } from './replay.ts';

/**
 * Wave 8b: Maya call e8a43f65 (2026-10-12) through the turn detector. Live (main 6107125, before
 * Wave 8) the caller's dates and cities became seven turns, and the agent answered half of them:
 * "…to the 5th." before "Of January.", and "Budapest, Vienna," before "in Austria. Then…".
 * `gap` is the modelled silence before "Germany, Berlin…" (see call4-timeline.ts).
 */
const turnsOf = (row: Record<string, unknown>, gap = 600) =>
  runCall(new FakeClock(), row, call4(gap)).map((turn) => ({
    text: turn.text,
    reason: turn.reason,
    endpointMs: Math.round(turn.endpointMs),
  }));

describe('call e8a43f65 issues 1, 2 and 7: continuation splits and their endpoints', () => {
  for (const [name, row] of [
    ['Maya’s row', MAYA],
    ['the recommended row', RECOMMENDED],
  ] as const)
    it(`${name}: a date range waits for its month, and a list stays one turn`, () => {
      // Wave 10: complete turns commit as the VAD stops, 50 ms sooner than Wave 8.
      expect(turnsOf(row)).toEqual([
        { text: SAID.turn1, reason: 'complete', endpointMs: 542 },
        // Issue 1: the range named December for its start and no month yet for its end, so the
        // turn waits the 700 ms hold (it ended 455 ms after the caller on the final, live) and the
        // engine holds its reply for the caller to go on (plugin-voice call4-engine-replay).
        { text: SAID.turn2, reason: 'hold', endpointMs: 1155 },
        // Issue 7: "Of January." carries that turn on, so it ends like a short answer: 547 ms,
        // where it waited 1797 ms for the stall with no VAD speech to time it.
        { text: SAID.turn3, reason: 'answer', endpointMs: 547 },
        // Issues 1 and 2 (already Wave 8's: the trailing comma holds the turn): "Budapest, Vienna,"
        // and "in Austria. Then…" are one turn, so nothing answers the caller mid-list.
        { text: `${SAID.turn4} ${SAID.turn5}`, reason: 'complete', endpointMs: 533 },
        // "…Zagreb, Prague." reads complete; the engine merges the next item into its reply.
        { text: SAID.turn6, reason: 'complete', endpointMs: 562 },
        { text: SAID.turn7, reason: 'complete', endpointMs: 486 },
      ]);
    });

  it('the list continued sooner after "Prague." is one turn with it', () => {
    expect(turnsOf(MAYA, 300).map((turn) => turn.text)).toEqual([
      SAID.turn1,
      SAID.turn2,
      SAID.turn3,
      `${SAID.turn4} ${SAID.turn5} ${SAID.turn6}`,
      SAID.turn7,
    ]);
  });

  it('the detector as it ran live (Wave 8 rules off) keeps "Of January." waiting for the stall', () => {
    // Reference for issue 7: the live endpoints, which the replay reproduces within 1 ms.
    expect(turnsOf(LIVE, 900)).toEqual([
      { text: SAID.turn1, reason: 'complete', endpointMs: 992 },
      { text: SAID.turn2, reason: 'hold', endpointMs: 1155 },
      { text: SAID.turn3, reason: 'stall', endpointMs: 1797 },
      { text: `${SAID.turn4} ${SAID.turn5}`, reason: 'complete', endpointMs: 983 },
      { text: SAID.turn6, reason: 'complete', endpointMs: 1012 },
      { text: SAID.turn7, reason: 'complete', endpointMs: 936 },
    ]);
  });

  it('only a few words carrying on a turn that trailed off end like an answer', () => {
    const run = (first: string, next: string) => {
      const f = replay(new FakeClock(), MAYA);
      f.utter(1500, first, 300);
      // Said softly, with no VAD run, 3.5 s after that turn ended.
      f.commits(next, 300);
      f.interim(next);
      f.clock.advance(5000);
      return f.turns.map((turn) => [turn.text, turn.reason]);
    };
    expect(run(SAID.turn2, SAID.turn3)).toEqual([
      [SAID.turn2, 'hold'],
      [SAID.turn3, 'answer'],
    ]);
    // A turn that ended complete, or words that start something new, wait for the stall.
    expect(run('I want to leave on the 21st of December.', SAID.turn3)[1]).toEqual([
      SAID.turn3,
      'stall',
    ]);
    expect(run(SAID.turn2, 'Two adults.')[1]).toEqual(['Two adults.', 'stall']);
  });
});
