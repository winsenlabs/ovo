import { describe, expect, it } from 'vitest';
import { FakeClock } from '@winsendotai/ovo-conformance/drivers';
import call7 from './fixtures/call7-endpoints.json' with { type: 'json' };
import { AFTER, BEFORE, replayLive, type FixtureTurn } from './call-endpoints.ts';

const clock = () => new FakeClock();

/**
 * Wave 12, F8: Wave 10's endpoint changes (commit.commitAtStop, completeSilenceMs 0) against Maya
 * call 8cb76efc (call 7, main b18b24e, which ran them). Each caller turn of the call replayed as it
 * was heard (call-endpoints.ts; fixtures/call7-endpoints.json, built from
 * /tmp/ovo/call7-events.jsonl as calls 5 and 6 were), Scribe answering every commit as long after
 * it as it did live. Rows: [turn, live rule, live endpointMs, rule and endpointMs with Wave 9's
 * row, with Wave 10's]. Wave 10's reproduces the live endpoint; Wave 9's ends the same words as
 * one turn, under the same rule, 0–50 ms later. Turns 14 and 17 ended 0.2 s after the VAD stop
 * and the caller went on 0.5 s and 0.3 s later: Wave 9 would have split them too, 50 ms later.
 * Turns opened over the agent (8, 21, 31) or that the replay cannot model (6, 10, 12 and 24: the
 * opening's muted words, and pauses inside a turn with no VAD stop measured) are in
 * call7-replay.test.ts where they matter.
 */
type Row = [string, string, number, string, number, string, number];

const ROWS: Row[] = [
  ['turn-7', 'unfinished', 826, 'unfinished', 825, 'unfinished', 825],
  ['turn-11', 'stall', 1875, 'stall', 1871, 'stall', 1871],
  ['turn-13', 'complete', 662, 'complete', 707, 'complete', 657],
  ['turn-14', 'complete', 202, 'complete', 250, 'complete', 200],
  ['turn-15', 'long', 819, 'long', 815, 'long', 815],
  ['turn-16', 'complete', 548, 'complete', 594, 'complete', 544],
  ['turn-17', 'complete', 201, 'complete', 250, 'complete', 200],
  ['turn-18', 'complete', 616, 'silence', 664, 'complete', 614],
  ['turn-19', 'complete', 609, 'silence', 654, 'complete', 604],
  ['turn-20', 'stall', 1873, 'stall', 1870, 'stall', 1870],
  ['turn-22', 'long', 774, 'long', 773, 'long', 773],
  ['turn-25', 'unfinished', 846, 'unfinished', 844, 'unfinished', 844],
  ['turn-26', 'complete', 959, 'complete', 958, 'complete', 958],
  ['turn-27', 'long', 793, 'long', 789, 'long', 789],
  ['turn-28', 'long', 851, 'long', 846, 'long', 846],
  ['turn-29', 'answer', 602, 'answer', 602, 'answer', 602],
  ['turn-30', 'complete', 539, 'complete', 586, 'complete', 536],
];

const turns = call7.turns as FixtureTurn[];
const find = (id: string) => turns.find((turn) => turn.id === id)!;

describe('call 8cb76efc (call 7): Wave 10 endpoints split no turn and ended none later', () => {
  it.each(ROWS)(
    '%s: Wave 10 reproduces the live endpoint; Wave 9 ends the same words',
    (id, rule, live, beforeRule, before, afterRule, after) => {
      const turn = find(id);
      const replayed = replayLive(clock, AFTER, turn, AFTER);
      expect(replayed.texts).toEqual([turn.text]);
      expect(replayed.reason).toBe(rule);
      expect(afterRule).toBe(rule);
      expect(replayed.endpointMs).toBe(after);
      // Within 10 ms: live adds the final's confidence wait and the engine's own turn of the loop.
      expect(live - after).toBeGreaterThanOrEqual(0);
      expect(live - after).toBeLessThanOrEqual(10);
      const wave9 = replayLive(clock, BEFORE, turn, AFTER);
      expect(wave9.texts).toEqual([turn.text]);
      expect({ reason: wave9.reason, endpointMs: wave9.endpointMs }).toEqual({
        reason: beforeRule,
        endpointMs: before,
      });
      expect(before - after).toBeGreaterThanOrEqual(0);
      expect(before - after).toBeLessThanOrEqual(50);
      // The LLM was never asked later than Wave 9 would have.
      expect(replayed.askedMs!).toBeLessThanOrEqual(wave9.askedMs!);
    },
  );
});
