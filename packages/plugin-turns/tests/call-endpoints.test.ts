import { describe, expect, it } from 'vitest';
import { FakeClock } from '@winsendotai/ovo-conformance/drivers';
import { AFTER, BEFORE, CALLS, replayLive, type FixtureTurn } from './call-endpoints.ts';

const clock = () => new FakeClock();

/**
 * Wave 10, L1 (call 4f1a919d): deciding the caller has stopped cost 350–670 ms on finished
 * utterances. Each turn of calls 5 and 6 replayed as it was heard, before (main 54fd9ea) and
 * after: [turn, live rule, live endpointMs, endpointMs before, endpointMs after, the rule after,
 * when the LLM is asked after (`askedMs`, timed as endpointMs; before, it was asked as the turn
 * ended, or when a final the caller went on after landed)]. First audio follows `askedMs` by the reply's compose and TTS time (compose alone
 * 1.1–1.7 s on call 4f1a919d without a search), so it comes as much sooner as the LLM is asked.
 */
type Row = [string, string, number, number, number, string, number];

// Call 4f1a919d (call 6).
const CALL6: Row[] = [
  // The interim at the VAD stop ended `Some..."`, then "December and December": the 250 ms wait
  // for words that trail off. Its final, "…December, January.", reads complete, but so would a
  // caller's who paused there and went on (call 10d5ef30 turn 13): the turn still waits those
  // 250 ms. The commit, and so the final and the LLM's request, come 250 ms sooner.
  ['turn-1', 'unfinished', 869, 861, 861, 'unfinished', 611],
  // "…drink a lot, so..." at the stop; the final "…so something like that." is complete.
  ['turn-2', 'unfinished', 863, 858, 858, 'unfinished', 608],
  ['turn-3', 'complete', 659, 654, 604, 'complete', 604],
  ['turn-4', 'complete', 572, 569, 519, 'complete', 519],
  // "Okay." with no VAD run: the answer stall, unchanged.
  ['turn-5', 'answer', 603, 602, 602, 'answer', 602],
  // "…fly to Europe from...": the caller thinking, the Wave 9 pause hold, unchanged. Its last
  // segment's final comes as much sooner as its commit.
  ['turn-6', 'pause', 3544, 3542, 3542, 'pause', -262],
  // "Chennai, Chennai." had no interim at the stop: the 50 ms `silenceMs` wait.
  ['turn-7', 'silence', 547, 544, 494, 'complete', 494],
  ['turn-8', 'silence', 609, 603, 553, 'complete', 553],
  ['turn-9', 'silence', 602, 601, 551, 'complete', 551],
  // "20. December 20th or 21st?": the interim at the stop ended on "December".
  ['turn-10', 'unfinished', 844, 840, 840, 'unfinished', 590],
  ['turn-11', 'complete', 621, 616, 552, 'complete', 552],
  ['turn-12', 'silence', 616, 614, 564, 'complete', 564],
];

// Call 10d5ef30 (call 5, main 519966b): turns 1, 12 and 15 now wait Wave 9's pause hold, and
// turn 16 ends on carrying turn 15 on (call5-replay.test.ts has those with their neighbours).
const CALL5: Row[] = [
  ['turn-3', 'long', 771, 766, 766, 'long', 516],
  ['turn-4', 'silence', 560, 556, 506, 'complete', 506],
  ['turn-5', 'long', 753, 749, 749, 'long', 499],
  ['turn-7', 'complete', 627, 623, 573, 'complete', 573],
  ['turn-8', 'complete', 570, 566, 516, 'complete', 516],
  // Scribe's last interim said what its final did: the final is announced stable all the same.
  ['turn-9', 'unfinished', 784, 782, 782, 'unfinished', 532],
  ['turn-10', 'silence', 580, 577, 527, 'complete', 527],
  // Two pauses after complete sentences ("…go this year or next.", "…stuff like that?") with a
  // stale interim at each stop: the caller went on after both, and is still one turn.
  ['turn-13', 'long', 834, 833, 833, 'long', 583],
  ['turn-14', 'unfinished', 768, 765, 765, 'unfinished', 515],
  ['turn-17', 'unfinished', 834, 831, 831, 'unfinished', 581],
  ['turn-18', 'complete', 565, 557, 507, 'complete', 507],
  // Its final came before the VAD stop: the turn ended at the commit.
  ['turn-19', 'complete', 250, 250, 200, 'complete', -257],
  ['turn-20', 'complete', 591, 590, 540, 'complete', 540],
  ['turn-21', 'silence', 641, 639, 589, 'complete', 589],
  ['turn-22', 'complete', 697, 694, 644, 'complete', 644],
  ['turn-23', 'silence', 594, 591, 541, 'complete', 541],
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
    (id, _rule, _live, before, after, reason, askedMs) => {
      const turn = find(turns, id);
      const replayed = replayLive(clock, AFTER, turn);
      // The same words, as one turn: no turn ends sooner on words that read unfinished, and the
      // finals of pauses inside it come as much sooner as their commits.
      expect(replayed.texts).toEqual([turn.text]);
      expect({
        endpointMs: replayed.endpointMs,
        reason: replayed.reason,
        askedMs: replayed.askedMs,
      }).toEqual({ endpointMs: after, reason, askedMs });
      expect(after).toBeLessThanOrEqual(before);
      // The LLM is never asked later than before, when it was asked as the turn ended.
      expect(askedMs).toBeLessThanOrEqual(replayLive(clock, BEFORE, turn).askedMs!);
    },
  );
});
