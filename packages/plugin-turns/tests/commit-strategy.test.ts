import { describe, expect, it } from 'vitest';
import { FakeClock } from '@winsendotai/ovo-conformance/drivers';
import type { SpeechCapabilities, TurnDecision, VoiceEvent } from '@winsendotai/ovo-contracts';
import { DetectorConfigSchema, createTurnDetector } from '../src/index.ts';

type WithoutTime<T> = T extends unknown ? Omit<T, 'atMs'> : never;

/** An STT that finalises only on a host commit, like Scribe with commit_strategy=manual. */
const manualCommit: SpeechCapabilities = {
  languages: ['en'],
  interim: true,
  wordTimestamps: false,
  forceEndpoint: true,
  turnSignals: [],
};
/** An STT with its own end-of-turn, like AssemblyAI. */
const providerTurns: SpeechCapabilities = { ...manualCommit, turnSignals: ['end-of-turn'] };

function fixture(
  row: Record<string, unknown> = {},
  { vad = true, stt = manualCommit }: { vad?: boolean; stt?: SpeechCapabilities } = {},
) {
  const clock = new FakeClock();
  const decisions: TurnDecision[] = [];
  const controller = createTurnDetector(row).create({
    clock,
    vad,
    language: 'en-IN',
    mode: 'agent',
    stt,
  });
  controller.on((decision) => decisions.push(decision));
  let revision = 0;
  const send = (event: WithoutTime<VoiceEvent>) =>
    controller.observe({ ...event, atMs: clock.now() } as VoiceEvent);
  const transcript = (text: string, stability: 'interim' | 'final', segmentId = '0') =>
    send({
      type: 'stt',
      event: { type: 'transcript', segment: { segmentId, revision: ++revision, text, stability } },
    });
  /** VAD speech of `ms`, with the clock advanced across it. */
  const speak = (ms: number, interim?: string) => {
    send({ type: 'vad.start' });
    if (interim) transcript(interim, 'interim');
    clock.advance(ms);
    send({ type: 'vad.stop' });
  };
  const forced = () => decisions.filter((d) => d.type === 'force-endpoint').length;
  const stopped = () =>
    decisions.flatMap((d) =>
      d.type === 'turn.stopped' && d.input.kind === 'speech' ? [d.input.text] : [],
    );
  return { clock, decisions, send, transcript, speak, forced, stopped };
}

describe("'commit' turn strategy", () => {
  it('commits as the VAD stops and ends the turn on the final, with no fixed wait', () => {
    const f = fixture();
    f.speak(600, 'mera naam');
    // Wave 10 (commitAtStop): no wait of its own after the VAD's 200 ms stopMs.
    f.clock.advance(0);
    expect(f.forced()).toBe(1);
    f.transcript('mera naam Ravi hai', 'final');
    // The vad-timeout strategy would hold this turn until userSpeechTimeoutMs (600 ms) elapsed.
    expect(f.stopped()).toEqual(['mera naam Ravi hai']);
    expect(f.forced()).toBe(1);
  });

  describe('Wave 10 (call 4f1a919d, L1): commits as the VAD stops, the final decides', () => {
    const reasons = (f: ReturnType<typeof fixture>) =>
      f.decisions.flatMap((d) => (d.type === 'turn.stopped' ? [d.reason] : []));

    it('a final that says what the last interim said is announced stable as it lands', () => {
      // Call 10d5ef30 turn 9: the interim had the final's words, so the final was never announced
      // and the LLM was asked only after the revisable partial's debounce, or as the turn ended.
      const said = 'Uh, what do you think about Zagreb as a place?';
      const f = fixture();
      f.send({ type: 'vad.start' });
      f.transcript(said, 'interim');
      f.clock.advance(1300);
      f.send({ type: 'vad.stop' });
      f.clock.advance(330);
      f.transcript(said, 'final');
      expect(
        f.decisions.flatMap((d) => (d.type === 'turn.partial' ? [[d.text, d.stable]] : [])),
      ).toEqual([
        [said, false],
        [said, true],
      ]);
    });

    it('an interim that trails off at the stop: its final is asked about 250 ms sooner', () => {
      // Turn 2: "…I also want to drink a lot, so..." at the VAD stop; Wave 8 committed 250 ms later,
      // so Scribe's final, and the LLM's request on it, came 250 ms later too.
      const said = 'I also want to drink a lot, so something like that.';
      const asked = (f: ReturnType<typeof fixture>) =>
        f.decisions.some((d) => d.type === 'turn.partial' && d.stable && d.text === said);
      const f = fixture();
      f.speak(1300, 'I also want to drink a lot, so...');
      f.clock.advance(0);
      expect(f.forced()).toBe(1);
      f.clock.advance(400);
      f.transcript(said, 'final');
      expect(asked(f)).toBe(true);
      // The turn still ends when Wave 8 ended it: a stale interim and a caller who pauses after a
      // complete sentence and goes on read the same at the stop (call 10d5ef30 turn 13).
      f.clock.advance(249);
      expect(f.stopped()).toEqual([]);
      f.clock.advance(1);
      expect(f.stopped()).toEqual([said]);
      expect(reasons(f)).toEqual(['unfinished']);
      const before = fixture({ commit: { commitAtStop: false } });
      before.speak(1300, 'I also want to drink a lot, so...');
      before.clock.advance(650);
      expect(asked(before)).toBe(false);
    });

    it.each([
      ['a list going on', 'I want to fly to Paris,', 'I want to fly to Paris.'],
      ['a trail-off', 'I want to fly to Paris, so...', 'I want to fly to Paris, so.'],
      [
        'a long utterance with no end signal',
        'I was thinking we could go',
        'I was thinking we could go.',
      ],
      // Call 10d5ef30 turn 13: the stale interim at the stop, and a final that says more.
      [
        'a stale interim',
        'What about Northern Lights and',
        'What about Northern Lights and stuff like that?',
      ],
    ])(
      'the same words closed by the early commit keep %s’s wait: a caller who goes on stays in',
      (_, interim, final) => {
        // Review of 0de1313: Scribe closes the segment an early commit cuts with a full stop, so its
        // final read complete and ended the turn ~330 ms after the stop; Wave 8 committed 250 ms
        // later and held a caller who went on until ~580 ms. The caller goes on at +350…+500.
        for (const resumeMs of [350, 400, 450, 500]) {
          const f = fixture();
          f.speak(1300, interim);
          f.clock.advance(0);
          expect(f.forced()).toBe(1);
          f.clock.advance(330);
          f.transcript(final, 'final');
          f.clock.advance(resumeMs - 330);
          expect(f.stopped()).toEqual([]);
          f.send({ type: 'vad.start' });
          f.transcript('and then Rome', 'interim', '1');
          f.clock.advance(800);
          f.send({ type: 'vad.stop' });
          f.clock.advance(330);
          f.transcript('and then Rome.', 'final', '1');
          f.clock.advance(1000);
          expect(f.stopped()).toEqual([`${final} and then Rome.`]);
        }
      },
    );

    it('those words wait out the rest all the same when the caller does not go on', () => {
      const f = fixture();
      f.speak(1300, 'I want to fly to Paris,');
      f.clock.advance(330);
      f.transcript('I want to fly to Paris.', 'final');
      // The 250 ms longSilenceMs from the stop, then Scribe's 330 ms: when Wave 8 ended it.
      f.clock.advance(249);
      expect(f.stopped()).toEqual([]);
      f.clock.advance(1);
      expect(f.stopped()).toEqual(['I want to fly to Paris.']);
      expect(reasons(f)).toEqual(['unfinished']);
    });

    it('a final with no end signal waits out the rest of its words’ silence, as Wave 8 did', () => {
      // A long utterance whose end reads neither way: Wave 8 committed 250 ms after the stop and
      // ended on the final; the final of the early commit now waits those 250 ms itself.
      const f = fixture();
      f.speak(1300, 'mujhe kal subah tak');
      f.clock.advance(400);
      f.transcript('mujhe kal subah tak chahiye', 'final');
      f.clock.advance(249);
      expect(f.stopped()).toEqual([]);
      f.clock.advance(1);
      expect(f.stopped()).toEqual(['mujhe kal subah tak chahiye']);
      expect(reasons(f)).toEqual(['long']);
    });

    it('the caller going on in that wait keeps the turn open', () => {
      const f = fixture();
      f.speak(1300, 'mujhe kal subah tak');
      f.clock.advance(400);
      f.transcript('mujhe kal subah tak chahiye', 'final');
      f.clock.advance(100);
      f.send({ type: 'vad.start' });
      f.transcript('theek hai', 'interim', '1');
      f.clock.advance(600);
      f.send({ type: 'vad.stop' });
      f.clock.advance(400);
      f.transcript('theek hai', 'final', '1');
      f.clock.advance(250);
      expect(f.stopped()).toEqual(['mujhe kal subah tak chahiye theek hai']);
    });

    it('the ceiling does not cut that wait short', () => {
      const f = fixture({ commit: { longSilenceMs: 900 } });
      f.speak(1300, 'mujhe kal subah tak');
      f.clock.advance(400);
      f.transcript('mujhe kal subah tak chahiye', 'final');
      // The commit's 600 ms ceiling would fire 200 ms into the 900 ms wait.
      f.clock.advance(899);
      expect(f.stopped()).toEqual([]);
      f.clock.advance(1);
      expect(f.stopped()).toEqual(['mujhe kal subah tak chahiye']);
      expect(reasons(f)).toEqual(['long']);
    });

    it('a final that trails off waits its silence and then the hold: as long as before', () => {
      for (const commitAtStop of [true, false]) {
        const f = fixture({ commit: { commitAtStop } });
        f.speak(1300, 'Do you know any');
        // Scribe answers 350 ms after the commit, which Wave 8 sent 250 ms after the stop.
        f.clock.advance(commitAtStop ? 350 : 600);
        f.transcript('Do you know any-', 'final');
        // Wave 12: a word broken off waits the 2.5 s pause hold (call 8cb76efc turns 21 and 24).
        f.clock.advance(commitAtStop ? 2_749 : 2_499);
        expect(f.stopped()).toEqual([]);
        f.clock.advance(1);
        expect(f.stopped()).toEqual(['Do you know any-']);
      }
    });

    it('a final in sooner than Scribe answers a commit answered an earlier one: no wait', () => {
      // Call e8a43f65 turn 2: a final 255 ms after the VAD stop, before Wave 8's 250 ms commit.
      const f = fixture();
      f.speak(1300, 'mujhe kal subah tak');
      f.clock.advance(255);
      f.transcript('mujhe kal subah tak chahiye', 'final');
      expect(f.stopped()).toEqual(['mujhe kal subah tak chahiye']);
    });

    it('a final already in hand at the stop ends the turn when Wave 8 would have committed', () => {
      const f = fixture();
      f.send({ type: 'vad.start' });
      f.transcript('mujhe kal subah tak chahiye', 'final');
      f.clock.advance(1300);
      f.send({ type: 'vad.stop' });
      f.clock.advance(249);
      expect(f.stopped()).toEqual([]);
      f.clock.advance(1);
      expect(f.stopped()).toEqual(['mujhe kal subah tak chahiye']);
      expect(f.forced()).toBe(0);
    });

    it('the final words are announced stable before the turn ends: the LLM is asked meanwhile', () => {
      const f = fixture();
      f.speak(1300, 'mujhe kal subah tak');
      f.clock.advance(400);
      f.transcript('mujhe kal subah tak chahiye', 'final');
      const types = f.decisions.map((d) => d.type);
      expect(f.decisions.at(-1)).toMatchObject({
        type: 'turn.partial',
        text: 'mujhe kal subah tak chahiye',
        stable: true,
      });
      expect(types).not.toContain('turn.stopped');
      f.clock.advance(250);
      expect(f.decisions.at(-1)).toMatchObject({ type: 'turn.stopped' });
    });
  });

  it("is what 'auto' picks for a manual-commit STT, while provider-turn STTs keep vad-timeout", () => {
    const commit = fixture();
    commit.speak(600, 'haan');
    commit.clock.advance(50);
    commit.transcript('haan ji', 'final');
    expect(commit.stopped()).toEqual(['haan ji']);

    const timeout = fixture({}, { stt: providerTurns });
    timeout.speak(600, 'haan');
    // vad-timeout forces the endpoint at the VAD stop, then waits out userSpeechTimeoutMs.
    expect(timeout.forced()).toBe(1);
    timeout.transcript('haan ji', 'final');
    expect(timeout.stopped()).toEqual([]);
    timeout.clock.advance(600);
    expect(timeout.stopped()).toEqual(['haan ji']);
  });

  it('never commits a click shorter than minSpeechMs with nothing transcribed', () => {
    const f = fixture();
    f.speak(100);
    f.clock.advance(5_000);
    expect(f.forced()).toBe(0);
  });

  it('with commitAtStop off, commits 50 ms after the VAD stop (Wave 8)', () => {
    const f = fixture({ commit: { commitAtStop: false } });
    f.speak(600, 'mera naam');
    f.clock.advance(49);
    expect(f.forced()).toBe(0);
    f.clock.advance(1);
    expect(f.forced()).toBe(1);
    f.transcript('mera naam Ravi hai', 'final');
    expect(f.stopped()).toEqual(['mera naam Ravi hai']);
  });

  it('keeps one turn when the caller resumes right after the VAD stop', () => {
    // Wave 10 (commitAtStop): the commit is sent at the stop; its final lands mid-speech and waits.
    const f = fixture();
    f.speak(400, 'kal');
    f.clock.advance(0);
    expect(f.forced()).toBe(1);
    f.clock.advance(30);
    f.send({ type: 'vad.start' });
    f.transcript('kal subah', 'interim');
    f.clock.advance(300);
    f.transcript('kal.', 'final');
    f.transcript('subah', 'interim', '1');
    f.clock.advance(100);
    f.send({ type: 'vad.stop' });
    f.clock.advance(0);
    expect(f.forced()).toBe(2);
    f.clock.advance(330);
    f.transcript('subah tak.', 'final', '1');
    f.clock.advance(1000);
    expect(f.stopped()).toEqual(['kal. subah tak.']);
  });

  it('cancels the commit when the caller resumes inside the local silence', () => {
    const f = fixture({ commit: { commitAtStop: false } });
    f.speak(400, 'kal');
    f.clock.advance(30);
    f.speak(400, 'kal subah');
    f.clock.advance(49);
    expect(f.forced()).toBe(0);
    f.clock.advance(1);
    expect(f.forced()).toBe(1);
  });

  it('ends the turn on a provider final that lands before the commit', () => {
    const f = fixture({ strategy: 'commit' }, { stt: providerTurns });
    f.speak(600, 'theek');
    f.transcript('theek hai', 'final');
    expect(f.stopped()).toEqual(['theek hai']);
    expect(f.forced()).toBe(0);
  });

  it('commits when the interim stalls although line noise keeps the VAD open', () => {
    const f = fixture();
    f.send({ type: 'vad.start' });
    f.transcript('main payment', 'interim');
    f.clock.advance(1_000);
    f.transcript('main payment', 'interim');
    f.clock.advance(499);
    expect(f.forced()).toBe(0);
    f.clock.advance(1);
    expect(f.forced()).toBe(1);
    // The VAD never stopped, but the final of the committed audio still ends the turn.
    f.transcript('main payment kar dunga', 'final');
    expect(f.stopped()).toEqual(['main payment kar dunga']);
  });

  it('ends on the interim text at the ceiling and drops that segment’s late final', () => {
    const f = fixture();
    f.speak(600, 'mujhe time chahiye');
    f.clock.advance(0);
    expect(f.forced()).toBe(1);
    f.clock.advance(599);
    expect(f.stopped()).toEqual([]);
    f.clock.advance(1);
    expect(f.stopped()).toEqual(['mujhe time chahiye']);
    f.transcript('mujhe time chahiye', 'final');
    expect(f.decisions.filter((d) => d.type === 'turn.started')).toHaveLength(1);
    // A new segment is a new turn as usual.
    f.speak(600);
    f.clock.advance(50);
    f.transcript('haan', 'final', '1');
    expect(f.stopped()).toEqual(['mujhe time chahiye', 'haan']);
  });

  it('forces the endpoint again in a second stalled turn while the VAD stays open', () => {
    // Regression: the endpoint flag outlived the turn, so only the first stall told the STT.
    const f = fixture();
    f.send({ type: 'vad.start' });
    f.transcript('main payment', 'interim');
    f.clock.advance(1_500);
    f.transcript('main payment kar dunga', 'final');
    f.transcript('kab tak', 'interim', '1');
    f.clock.advance(1_500);
    expect(f.forced()).toBe(2);
    f.transcript('kab tak hoga', 'final', '1');
    expect(f.stopped()).toEqual(['main payment kar dunga', 'kab tak hoga']);
  });

  it('forces the endpoint on every stalled turn without a VAD', () => {
    // Words that are not a short complete answer ("Yes.", "Hello"), which commits sooner.
    const f = fixture({}, { vad: false });
    f.transcript('I want', 'interim');
    f.clock.advance(1_500);
    f.transcript('I want to pay', 'final');
    f.transcript('second', 'interim', '1');
    f.clock.advance(1_500);
    expect(f.forced()).toBe(2);
    f.transcript('second one', 'final', '1');
    expect(f.stopped()).toEqual(['I want to pay', 'second one']);
  });

  it("runs without a VAD under 'auto' instead of refusing a manual-commit STT", () => {
    const f = fixture({}, { vad: false });
    f.transcript('I want', 'interim');
    f.clock.advance(1_500);
    expect(f.forced()).toBe(1);
    f.transcript('I want to pay', 'final');
    expect(f.stopped()).toEqual(['I want to pay']);
    expect(() => fixture({ strategy: 'provider' }, { vad: false })).toThrow(/end-of-turn/);
  });

  it('parses the commit settings with their POC defaults and rejects unknown keys', () => {
    expect(DetectorConfigSchema.parse({}).commit).toEqual({
      silenceMs: 50,
      completeSilenceMs: 0,
      commitAtStop: true,
      longSilenceMs: 250,
      longUtteranceMs: 1200,
      minSpeechMs: 180,
      stallMs: 1500,
      answerStallMs: 250,
    });
    expect(DetectorConfigSchema.parse({}).noiseMs).toBe(2500);
    expect(DetectorConfigSchema.parse({ strategy: 'commit' }).strategy).toBe('commit');
    expect(() => DetectorConfigSchema.parse({ commit: { silence: 1 } })).toThrow();
    expect(() => DetectorConfigSchema.parse({ unknown: true })).toThrow();
  });

  it('a configured silence and a disabled stall fallback are honoured', () => {
    // Ten seconds of speech is a long utterance: its silence is never shorter than silenceMs. The
    // VAD run brings no new words for 10 s, so the room rule (noiseMs) is off here too.
    const f = fixture({
      commit: { silenceMs: 200, longSilenceMs: 0, stallMs: 0, commitAtStop: false },
      noiseMs: 0,
    });
    f.send({ type: 'vad.start' });
    f.transcript('ek', 'interim');
    f.clock.advance(10_000);
    expect(f.forced()).toBe(0);
    f.send({ type: 'vad.stop' });
    f.clock.advance(199);
    expect(f.forced()).toBe(0);
    f.clock.advance(1);
    expect(f.forced()).toBe(1);
  });
});
