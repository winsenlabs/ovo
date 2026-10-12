import { describe, expect, it } from 'vitest';
import { FakeClock } from '@winsendotai/ovo-conformance/drivers';
import { replayCall, runCall } from './call4-timeline.ts';
import {
  call5Closing,
  call5Fragment,
  call5Hesitation,
  call5Opening,
  call5OverAgent,
  SAID5,
} from './call5-timeline.ts';
import { RECOMMENDED } from './replay.ts';

/**
 * Wave 9, issue D3: Maya call 10d5ef30 (2026-10-12, main 519966b) through the turn detector. Live,
 * three utterances the caller went on with were ended as turns of their own: "…what places are
 * nice in-" (rule unfinished, 451 ms), "No, umm..." (hold, 1486 ms) and "…it should still be a"
 * (hold, 1152 ms). The engine merged each into the next turn's reply, but the replies made for
 * them in between asked the caller to say it again. Her row had no commit.silenceMs by then
 * (normal endpoints were 0.56–0.64 s), so the recommended row is hers.
 */
const turnsOf = (steps: Parameters<typeof runCall>[2]) =>
  runCall(new FakeClock(), RECOMMENDED, steps).map((turn) => ({
    text: turn.text,
    reason: turn.reason,
    atMs: Math.round(turn.atMs),
  }));

describe('call 10d5ef30 D3: words that stop mid-thought keep the turn open', () => {
  it('turns 1–2: "…nice in-" waits through the caller’s words, timed from their silence', () => {
    // Live the stall committed "…nice in-" at 11.76 s while the caller was still talking, its
    // 700 ms hold ran out under their words, and the VAD stop ended the turn at once (12.48 s).
    expect(turnsOf(call5Opening())).toEqual([
      // One turn. Its last word ends it as an answer would (live turn 2 waited for the stall,
      // ending at 15.427 s).
      { text: `${SAID5.turn1} ${SAID5.turn2}`, reason: 'answer', atMs: 14_177 },
    ]);
  });

  it('turns 12–13: "No, umm..." waits for the caller thinking aloud', () => {
    // Live the hold ended it at 176.140 s; the VAD heard the caller again 14 ms later.
    expect(turnsOf(call5Hesitation())).toEqual([
      { text: `${SAID5.turn12} ${SAID5.turn13a}`, reason: 'complete', atMs: 180_650 },
    ]);
  });

  it('turns 15–16: "…it should still be a" waits, and "built-in." ends it like an answer', () => {
    expect(turnsOf(call5Fragment())).toEqual([
      { text: SAID5.turn14b, reason: 'unfinished', atMs: 216_279 },
      // Live "built-in." was a turn of its own, ended 633 ms after its words (rule answer): one
      // turn now, ended at the same moment.
      { text: `${SAID5.turn15} ${SAID5.turn16}`, reason: 'answer', atMs: 222_790 },
    ]);
  });

  it('words that stop mid-thought with no more to come end on the pause, 2.5 s after the commit', () => {
    const steps = call5Fragment().filter((step) => step.at < 222_000);
    expect(turnsOf(steps).at(-1)).toEqual({
      text: SAID5.turn15,
      reason: 'pause',
      // The commit 250 ms after the VAD stop (219.824 s), then the 2.5 s pause: 1.8 s later than
      // live (220.526 s), but the engine no longer holds this reply 2 s for the caller.
      atMs: 222_324,
    });
  });

  it('other trailing words keep the 700 ms hold', () => {
    const steps = call5Fragment()
      .filter((step) => step.at < 222_000)
      .map((step) =>
        'final' in step && step.final === SAID5.turn15
          ? { ...step, final: 'And stuff like that. I mean, Prague, Vienna,' }
          : step,
      );
    expect(turnsOf(steps).at(-1)).toMatchObject({ reason: 'hold', atMs: 220_524 });
  });
});

describe('call 10d5ef30 D6: no filler before a goodbye', () => {
  it('turn 22: "Never mind. Thank you." is offered no "One moment."', () => {
    // Live its reply ("Shall I end the call?") was ready 1.68 s after the turn, so the 1.5 s filler
    // played for 180 ms and was cut. A closing is answered with a goodbye, which needs no filler.
    const turns = runCall(new FakeClock(), RECOMMENDED, call5Closing());
    expect(turns.map(({ text, filler }) => ({ text, filler }))).toEqual([
      { text: SAID5.turn21, filler: 'One moment.' },
      { text: SAID5.turn22, filler: undefined },
    ]);
  });
});

describe('call 10d5ef30 D2: words over the agent that the VAD never heard', () => {
  it('turn 6: "Yeah. Also, what more..." is taken for the room, as Wave 8 decided', () => {
    // Not lost by the reply pipeline: the speech-evidence gate (bargeIn) drops words said over the
    // agent with no VAD speech behind them once the VAD has heard this caller (turn 5). Live turn
    // 11 ("Tell me the name.", interims only) went the same way. The VAD missed this caller's soft
    // speech in silence too (turns 2 and 16 had no VAD run): its caller gate (12 dB under the
    // learned level) is the likely cause, which only the call's audio can confirm.
    const { f } = replayCall(new FakeClock(), RECOMMENDED, call5OverAgent());
    expect(f.turns.map((turn) => turn.text)).toEqual([SAID5.turn5]);
    expect(f.resets).toEqual(['backchannel']);
  });
});
