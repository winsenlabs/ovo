import { describe, expect, it } from 'vitest';
import { FakeClock } from '@winsendotai/ovo-conformance/drivers';
import { AFTER, BEFORE, CALLS, replayLive, type FixtureTurn } from './call-endpoints.ts';

const clock = () => new FakeClock();

/**
 * Wave 10, L1 (call 4f1a919d): deciding the caller has stopped cost 350–670 ms on finished
 * utterances. Each turn of calls 5 and 6 replayed as it was heard, before (main 54fd9ea) and
 * after: [turn, live rule, live endpointMs, endpointMs before, endpointMs and rule after].
 */
type Row = [string, string, number, number, number, string];

// Call 4f1a919d (call 6).
const CALL6: Row[] = [
  // The interim at the VAD stop ended `Some..."`, then "December and December": the 250 ms wait
  // for words that trail off. The final, "…December, January.", reads complete.
  ['turn-1', 'unfinished', 869, 861, 611, 'complete'],
  // "…drink a lot, so..." at the stop; the final "…so something like that." is complete.
  ['turn-2', 'unfinished', 863, 858, 608, 'complete'],
  ['turn-3', 'complete', 659, 654, 604, 'complete'],
  ['turn-4', 'complete', 572, 569, 519, 'complete'],
  // "Okay." with no VAD run: the answer stall, unchanged.
  ['turn-5', 'answer', 603, 602, 602, 'answer'],
  // "…fly to Europe from...": the caller thinking, the Wave 9 pause hold, unchanged.
  ['turn-6', 'pause', 3544, 3542, 3542, 'pause'],
  // "Chennai, Chennai." had no interim at the stop: the 50 ms `silenceMs` wait.
  ['turn-7', 'silence', 547, 544, 494, 'complete'],
  ['turn-8', 'silence', 609, 603, 553, 'complete'],
  ['turn-9', 'silence', 602, 601, 551, 'complete'],
  // "20. December 20th or 21st?": the interim at the stop ended on "December".
  ['turn-10', 'unfinished', 844, 840, 590, 'complete'],
  ['turn-11', 'complete', 621, 616, 552, 'complete'],
  ['turn-12', 'silence', 616, 614, 564, 'complete'],
];

// Call 10d5ef30 (call 5, main 519966b): turns 1, 12 and 15 now wait Wave 9's pause hold, and
// turn 16 ends on carrying turn 15 on (call5-replay.test.ts has those with their neighbours).
const CALL5: Row[] = [
  ['turn-3', 'long', 771, 766, 516, 'complete'],
  ['turn-4', 'silence', 560, 556, 506, 'complete'],
  ['turn-5', 'long', 753, 749, 499, 'complete'],
  ['turn-7', 'complete', 627, 623, 573, 'complete'],
  ['turn-8', 'complete', 570, 566, 516, 'complete'],
  ['turn-9', 'unfinished', 784, 782, 532, 'complete'],
  ['turn-10', 'silence', 580, 577, 527, 'complete'],
  ['turn-13', 'long', 834, 833, 583, 'complete'],
  ['turn-14', 'unfinished', 768, 765, 515, 'complete'],
  ['turn-17', 'unfinished', 834, 831, 581, 'complete'],
  ['turn-18', 'complete', 565, 557, 507, 'complete'],
  // Its final came before the VAD stop: the turn ended at the commit.
  ['turn-19', 'complete', 250, 250, 200, 'complete'],
  ['turn-20', 'complete', 591, 590, 540, 'complete'],
  ['turn-21', 'silence', 641, 639, 589, 'complete'],
  ['turn-22', 'complete', 697, 694, 644, 'complete'],
  ['turn-23', 'silence', 594, 591, 541, 'complete'],
];

const find = (turns: FixtureTurn[], id: string) => turns.find((turn) => turn.id === id)!;

describe.each([
  ['4f1a919d (call 6)', CALLS.call6, CALL6],
  ['10d5ef30 (call 5)', CALLS.call5, CALL5],
])('call %s: the endpoint of every turn', (_, turns, rows) => {
  it.each(rows)('%s: the replay reproduces the live endpoint', (id, rule, live, before) => {
    const turn = find(turns, id);
    const replayed = replayLive(clock, BEFORE, turn);
    expect(replayed.texts).toEqual([turn.text]);
    expect(replayed.reason).toBe(rule);
    // Within 10 ms: live adds the final's confidence wait and the engine's own turn of the loop.
    expect(live - replayed.endpointMs!).toBeGreaterThanOrEqual(0);
    expect(live - replayed.endpointMs!).toBeLessThanOrEqual(10);
    expect(replayed.endpointMs).toBe(before);
  });

  it.each(rows)(
    '%s: commits as the VAD stops and lets the final decide',
    (id, _rule, _live, before, after, reason) => {
      const turn = find(turns, id);
      const replayed = replayLive(clock, AFTER, turn);
      // The same words, as one turn: no turn ends sooner on words that read unfinished.
      expect(replayed.texts).toEqual([turn.text]);
      expect({ endpointMs: replayed.endpointMs, reason: replayed.reason }).toEqual({
        endpointMs: after,
        reason,
      });
      expect(after).toBeLessThanOrEqual(before);
    },
  );
});
