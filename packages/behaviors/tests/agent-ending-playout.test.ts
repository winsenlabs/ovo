import { describe, expect, it } from 'vitest';
import type { SpeechReceipt } from '@winsendotai/ovo-contracts';
import { CallEnding } from '../src/agent-ending.ts';
import { PlayoutPace } from '../src/agent-playout.ts';

const OPENING = 'Hi! This is Ananya from CreditMantri, calling about your loan.';
const GOODBYE = 'Understood, we will not call you again. Thank you, goodbye.';

function line(
  text: string,
  epoch: number,
  state: SpeechReceipt['state'],
  playedMs?: number,
): SpeechReceipt {
  return {
    id: `${epoch}:${text}`,
    text,
    epoch,
    state,
    evidence: 'confirmed',
    ...(playedMs === undefined ? {} : { playedMs }),
  };
}

/** A call whose opening played at 70 ms a character, then a terminal one-line goodbye. */
function goodbyeSaid(): CallEnding {
  const ending = new CallEnding();
  ending.beginTurn(1);
  ending.startTurn();
  ending.said(OPENING);
  ending.played(line(OPENING, 1, 'completed', OPENING.length * 70));
  ending.beginTurn(2);
  ending.startTurn();
  ending.arm('decision:flow:stop_calling', { terminal: true });
  ending.said(GOODBYE);
  ending.seal();
  return ending;
}

describe('a terminal goodbye cut in its last words was heard (playedMs)', () => {
  it('ends the call on a goodbye cut at 95% instead of saying it again in full', () => {
    const ending = goodbyeSaid();
    ending.played(line(GOODBYE, 2, 'interrupted', GOODBYE.length * 70 * 0.95));
    expect(ending.complete).toBe(true);
    expect(ending.reason).toBe('decision:flow:stop_calling');
    expect(ending.close('decision:flow:stop_calling')).toEqual([]);
  });

  it('says a goodbye cut halfway once more, as before', () => {
    const ending = goodbyeSaid();
    ending.played(line(GOODBYE, 2, 'interrupted', GOODBYE.length * 70 * 0.5));
    expect(ending.complete).toBe(false);
    expect(ending.close('decision:flow:stop_calling')).toEqual([GOODBYE]);
  });

  it('without playedMs a cut goodbye was not heard', () => {
    const ending = goodbyeSaid();
    ending.played(line(GOODBYE, 2, 'interrupted'));
    expect(ending.complete).toBe(false);
  });
});

describe('PlayoutPace', () => {
  it("learns the call's pace from completed lines and judges cut ones against it", () => {
    const pace = new PlayoutPace();
    // Unmeasured, it assumes a slow 75 ms a character: 90% of 40 characters is 2700 ms.
    const cut = (playedMs: number) => line('x'.repeat(40), 1, 'interrupted', playedMs);
    expect(pace.heard(cut(2699))).toBe(false);
    expect(pace.heard(cut(2700))).toBe(true);
    pace.observe(line('y'.repeat(50), 1, 'completed', 3000));
    // 60 ms a character now: 90% of 40 characters is 2160 ms.
    expect(pace.heard(cut(2160))).toBe(true);
    expect(pace.heard(cut(2100))).toBe(false);
  });

  it('ignores lines too short to time, and completions no playback could take', () => {
    const pace = new PlayoutPace();
    pace.observe(line('Hi.', 1, 'completed', 900));
    pace.observe(line('z'.repeat(50), 1, 'completed', 15_000));
    expect(pace.heard(line('x'.repeat(40), 1, 'interrupted', 2600))).toBe(false);
  });
});
