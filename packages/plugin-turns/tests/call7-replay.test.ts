import { describe, expect, it } from 'vitest';
import { FakeClock } from '@winsendotai/ovo-conformance/drivers';
import { replayCall, runCall, type Step } from './call4-timeline.ts';
import { call7BrokenOff, call7Please, call7WhatHappens, SAID7 } from './call7-timeline.ts';
import { RECOMMENDED, replay } from './replay.ts';

/**
 * Wave 12: Maya call 8cb76efc (2026-10-14, main b18b24e) through the turn detector, with Maya's
 * row (RECOMMENDED: Wave 10's defaults, as live).
 */
const turnsOf = (steps: Step[]) =>
  runCall(new FakeClock(), RECOMMENDED, steps).map((turn) => ({
    text: turn.text,
    reason: turn.reason,
    atMs: Math.round(turn.atMs),
  }));

describe('call 8cb76efc F4: words the STT broke off keep the turn open', () => {
  it('turns 21–22: "No. Have there been any-" waits for "…Crime incidents…"', () => {
    // Live the 700 ms hold ended "No. Have there been any-" at 188.895 s, 0.8 s before the
    // caller went on, and the LLM wrote "Could you finish your question?" for it.
    expect(turnsOf(call7BrokenOff())).toEqual([
      {
        text: `${SAID7.turn21} ${SAID7.turn22a} ${SAID7.turn22b}`,
        // Ended as live turn 22 did (193.064 s).
        reason: 'long',
        atMs: 193_063,
      },
    ]);
  });

  it('turns 24–25: "…uh, what happens-" waits for "In Berlin on New Year\'s Eve?"', () => {
    // Live the hold ended it at 220.167 s, 364 ms before "Berlin, Berlin,", and the LLM wrote
    // "Sorry, could you say that again?" for it.
    expect(turnsOf(call7WhatHappens())).toEqual([
      {
        text: `${SAID7.turn24a} ${SAID7.turn24b} ${SAID7.turn25}`,
        // Ended as live turn 25 did (221.416 s).
        reason: 'unfinished',
        atMs: 221_414,
      },
    ]);
  });

  it('a broken-off turn the caller never goes on with ends on the pause, 2.5 s after its final', () => {
    const steps = call7BrokenOff().filter((step) => step.at < 189_000);
    // 2.5 s of silence before the reply, against the 0.7 s hold and the engine's 2 s reply hold
    // before: the caller is asked to finish only after that long a silence.
    expect(turnsOf(steps)).toEqual([{ text: SAID7.turn21, reason: 'pause', atMs: 190_692 }]);
  });
});

describe('call 8cb76efc F2: words that add nothing to a reply on its way', () => {
  it('turn 20: "Please." over the search line is answered by that reply, not queued after it', () => {
    const { f } = replayCall(new FakeClock(), RECOMMENDED, call7Please());
    expect(f.turns.map((turn) => turn.text)).toEqual([SAID7.turn19]);
    expect(f.resets).toEqual(['backchannel']);
    expect(f.resetTexts).toEqual([SAID7.turn20]);
  });

  it.each([
    ['a no', 'No.'],
    ['a goodbye', 'Never mind, thank you. Bye.'],
    ['a new request', 'Please check Split too.'],
  ])('%s said then is still a turn', (_, words) => {
    const steps = call7Please().map((step) =>
      'interim' in step
        ? { ...step, interim: words }
        : 'commit' in step
          ? { ...step, commit: words }
          : step,
    );
    const { f } = replayCall(new FakeClock(), RECOMMENDED, steps);
    expect(f.turns.map((turn) => turn.text)).toEqual([SAID7.turn19, words]);
  });

  it('with no filler or search line playing, the reply is not known to be on its way', () => {
    const steps = call7Please().filter((step) => !('agent' in step && step.agent === 'filler'));
    const { f } = replayCall(new FakeClock(), RECOMMENDED, steps);
    expect(f.turns.map((turn) => turn.text)).toEqual([SAID7.turn19, SAID7.turn20]);
  });

  it('once a line of the reply has played, "Please." is the caller\'s turn again', () => {
    const steps: Step[] = [
      ...call7Please().filter((step) => step.at < 172_400),
      { at: 172_400, agent: 'start' },
      { at: 172_410, agent: 'stop' },
      ...call7Please().filter((step) => step.at >= 172_400),
    ];
    const { f } = replayCall(new FakeClock(), RECOMMENDED, steps);
    expect(f.turns.map((turn) => turn.text)).toEqual([SAID7.turn19, SAID7.turn20]);
  });

  it.each([
    ['"Please."', SAID7.turn20],
    // Turn 26 ("No. I- Bueno, buenas tardes.") superseded the held answer to "In Berlin on New
    // Year's Eve?" this way; its words read as English to the language guard (cross-lane request).
    ["words outside the agent's languages", 'Bueno, gracias, señor.'],
  ])('%s after the search line has ended, the reply still to come, are dropped too', (_, words) => {
    const steps: Step[] = [
      ...call7Please().map((step) =>
        'interim' in step
          ? { ...step, interim: words }
          : 'commit' in step
            ? { ...step, commit: words }
            : step,
      ),
      // The search line ended before the words: the agent is quiet.
      { at: 172_400, agent: 'stop' },
    ];
    const { f } = replayCall(new FakeClock(), { ...RECOMMENDED, languages: ['en', 'hi'] }, steps);
    expect(f.turns.map((turn) => turn.text)).toEqual([SAID7.turn19]);
    expect(f.resets).toEqual(['backchannel']);
  });
});

/**
 * Turn 6's opening: the caller spoke (two bursts, ~1.5 s, on the caller track) over "This call is
 * recorded for quality. Hi! I'm Maya…" (25–6912 ms), and Scribe heard Hindi ("हाँ, ठीक है। आप
 * इसको लगा दो।"); muted, those words were dropped as turns 1–5. Nothing committed them, so Scribe
 * kept revising that segment for 3 s and, when the caller spoke again at 8.3 s, carried it on:
 * turn 6 began "हाँ, जी। हाँ, इस पर बात करो। Hi, Maya. We are planning to take a trip.".
 *
 * Scribe is modelled as a manual-commit STT: its open segment says what it heard since the last
 * commit, and a commit finalises it 350 ms later (`final`, then a new segment). Live, with no
 * commit, its texts are the measured ones; after a commit, the segment it opens holds only the
 * words heard after it (modelled: the measured text less the committed words). The muted VAD run
 * is modelled from the caller track (one run, 800–2450 ms: its two bursts, 0.6 s apart).
 */
function opening(row: Record<string, unknown>) {
  const f = replay(new FakeClock(), row, { opening: true });
  const start = f.clock.now();
  const at = (ms: number) => f.clock.advance(Math.max(0, start + ms - f.clock.now()));
  let open = '';
  let committed = false;
  f.onForced(() => {
    const text = open;
    open = '';
    committed = true;
    f.clock.setTimeout(() => f.final(text), 350);
  });
  /** Scribe's text for the open segment: as live, or after a commit only the newer words. */
  const said = (live: string, fresh?: string) => (open = committed ? (fresh ?? '') : live);
  at(25);
  f.agentSays('disclosure');
  at(800);
  f.send({ type: 'vad.start' });
  at(1_333);
  f.interim(said('Happy.', 'Happy.'));
  at(2_239);
  f.interim(said('हाँ, ठीक है। आप इसको लगा दो।', 'हाँ, ठीक है। आप इसको लगा दो।'));
  at(2_450);
  f.send({ type: 'vad.stop' });
  // Live revisions of the same words, with no new audio: none once they are committed.
  for (const [ms, text] of [
    [3_337, 'हाँ, ठीक है। हाँ, इसको लगाता हूँ।'],
    [4_241, 'हाँ, ठीक है। हाँ, इस पर रखो।'],
    [5_178, 'हाँ, ठीक है। हाँ, इसको लगाता हूँ।'],
  ] as const) {
    at(ms);
    if (!committed) f.interim(said(text));
  }
  at(6_912);
  f.agentStops();
  at(8_330);
  f.send({ type: 'vad.start' });
  at(9_002);
  f.interim(said('हाँ, ठीक है। हाँ, इस पर रखो। Hi,', 'Hi,'));
  at(9_908);
  f.interim(
    said(
      'हाँ, जी। हाँ, इस पर बात करो। Hi, Maya. We are planning to take',
      'Hi, Maya. We are planning to take',
    ),
  );
  at(10_135);
  f.final(
    said(
      'हाँ, जी। हाँ, इस पर बात करो। Hi, Maya. We are planning to take a trip.',
      'Hi, Maya. We are planning to take a trip.',
    ),
  );
  // Modelled: the VAD stop after "…a trip." (live the caller went on: "Sometime in December…").
  at(10_400);
  f.send({ type: 'vad.stop' });
  f.clock.advance(5_000);
  return f;
}

describe('call 8cb76efc F6: words muted over the opening never start the next turn', () => {
  it('turn 6: the Hindi heard over the opening is committed when it ends, and dropped', () => {
    const f = opening(RECOMMENDED);
    expect(f.turns.map((turn) => turn.text)).toEqual(['Hi, Maya. We are planning to take a trip.']);
    // One commit, at the muted VAD stop: the turn's final was in hand at its own stop.
    expect(f.forced()).toBe(1);
    expect(f.resets.every((reason) => reason === 'muted')).toBe(true);
  });

  it('muted words with no VAD run behind them are committed when the agent stops', () => {
    const f = replay(new FakeClock(), RECOMMENDED, { opening: true });
    f.agentSays('disclosure');
    f.clock.advance(1_000);
    f.interim('हाँ, ठीक है।');
    f.clock.advance(1_000);
    expect(f.forced()).toBe(0);
    f.agentStops();
    expect(f.forced()).toBe(1);
    // Scribe's final for those words lands after the agent stopped: it opens no turn.
    f.clock.advance(350);
    f.final('हाँ, ठीक है।');
    f.clock.advance(5_000);
    expect(f.turns).toEqual([]);
  });
});
