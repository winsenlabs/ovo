import { describe, expect, it } from 'vitest';
import type { TurnDecision, VoiceEvent } from '@winsendotai/ovo-contracts';
import { FakeClock } from '../../conformance/src/drivers/fake-clock.ts';
import { createTurnDetector } from '../../plugin-turns/src/index.ts';
import { TurnLatency } from '../src/engine/latency.ts';
import { SpeechEventProjector } from '../src/engine/speech-events.ts';
import { REPLY_HOLD } from '../src/engine/turn-hold.ts';
import { mergeUtterances } from '../src/engine/turn-speculation.ts';
import { driverHarness, slowAgent } from './turn-harness.ts';

const FILLER = { text: 'Okay, one moment.', afterMs: 600 };

/**
 * P1, from call 8cbac365 (2026-10-07), turns 5 and 6, times relative to turn-5 stopping at
 * 13:06:25.178: the caller paused mid-sentence and the turn ended; 443 ms later they spoke again
 * (VAD turn start); the LLM reply was ready at 1043 ms and played over them; their words were first
 * transcribed at 2008 ms (and barged in on the reply), and their turn ended at 3808 ms.
 */
const T5 =
  "Ma'am, what is this? I am so random. I am-- Hello, wait, listen to me, only then you will be--";
const T6 = "What is this? You're so random. You didn't even tell me what the product is.";
const LIVE = { resumedMs: 443, llmMs: 1043, wordsMs: 2008, stoppedMs: 3808 };

describe('a reply is held while the caller speaks again before hearing it (P1)', () => {
  it('replays the live talk-over: one reply to the whole utterance, after the caller stops', async () => {
    const clock = new FakeClock();
    const agent = slowAgent(clock, { llmMs: LIVE.llmMs });
    const h = driverHarness(clock, agent.behavior, {
      ttsMs: 150,
      playMs: 2000,
      fillers: [FILLER.text],
    });
    const t0 = await h.greet();
    h.turn.stopped('turn-5', T5, FILLER);
    await clock.advanceAsync(LIVE.resumedMs);
    h.turn.vad('vad.start');
    h.turn.started('turn-6');
    await clock.advanceAsync(LIVE.wordsMs - LIVE.resumedMs);
    h.turn.partial('turn-6', 'What is this? You are so');
    await clock.advanceAsync(LIVE.stoppedMs - LIVE.wordsMs);
    h.turn.vad('vad.stop');
    h.turn.stopped('turn-6', T6);
    await clock.advanceAsync(10_000);

    const merged = mergeUtterances(T5, T6);
    expect(agent.asked).toEqual([T5, merged]);
    // Nothing played over the caller: not the stale reply (live: at 1193 ms), not the filler.
    expect(h.audio.map((line) => [line.text, line.atMs - t0])).toEqual([
      [`Answer: ${merged}.`, LIVE.stoppedMs + LIVE.llmMs + 150],
    ]);
    expect(agent.receipts.filter((receipt) => receipt.startsWith('completed'))).toEqual([
      'completed:Hello, this is Asha.',
      `completed:Answer: ${merged}.`,
    ]);
  });

  it('plays the held reply once the VAD has been quiet with no words (a beep or rumble)', async () => {
    const clock = new FakeClock();
    const agent = slowAgent(clock, { fastMs: 300 });
    const h = driverHarness(clock, agent.behavior, { ttsMs: 100, playMs: 1500 });
    const t0 = await h.greet();
    h.turn.stopped('turn-1', 'rule yes');
    await clock.advanceAsync(100);
    h.turn.vad('vad.start');
    h.turn.started('turn-2');
    await clock.advanceAsync(250);
    h.turn.vad('vad.stop');
    await clock.advanceAsync(5000);
    // The detector's own safety timer drops the empty turn much later; nothing changes then.
    h.turn.reset('turn-2');
    await clock.advanceAsync(5000);
    expect(agent.asked).toEqual(['rule yes']);
    // Ready at 300 ms; without the noise it plays at 400 ms. The blip costs quietMs at most.
    expect(h.audio.map((line) => [line.text, line.atMs - t0])).toEqual([
      ['Answer: rule yes.', 350 + REPLY_HOLD.quietMs + 100],
    ]);
  });

  it('plays the held reply as soon as the recogniser closes the utterance with no words', async () => {
    const clock = new FakeClock();
    const agent = slowAgent(clock, { fastMs: 300 });
    const h = driverHarness(clock, agent.behavior, { ttsMs: 100, playMs: 1500 });
    const t0 = await h.greet();
    h.turn.stopped('turn-1', 'rule yes');
    await clock.advanceAsync(100);
    h.turn.vad('vad.start');
    h.turn.started('turn-2');
    await clock.advanceAsync(300);
    h.turn.vad('vad.stop');
    // The commit is answered with an empty transcript: Scribe sends only its end-of-turn.
    await clock.advanceAsync(400);
    h.bus.observe({ type: 'stt', atMs: clock.now(), event: { type: 'end-of-turn' } });
    await clock.advanceAsync(5000);
    expect(h.audio.map((line) => [line.text, line.atMs - t0])).toEqual([
      ['Answer: rule yes.', 800 + 100],
    ]);
  });

  it('plays the held reply at once when the turn is dropped as a backchannel or muted', async () => {
    const clock = new FakeClock();
    const agent = slowAgent(clock, { fastMs: 300 });
    const h = driverHarness(clock, agent.behavior, { ttsMs: 100, playMs: 1500 });
    const t0 = await h.greet();
    h.turn.stopped('turn-1', 'rule yes');
    await clock.advanceAsync(100);
    h.turn.started('turn-2');
    h.turn.partial('turn-2', 'haan');
    await clock.advanceAsync(400);
    h.turn.reset('turn-2');
    await clock.advanceAsync(5000);
    expect(agent.asked).toEqual(['rule yes']);
    expect(h.audio.map((line) => [line.text, line.atMs - t0])).toEqual([
      ['Answer: rule yes.', 500 + 100],
    ]);
  });

  it('takes back a line still being synthesised, so none of it is heard until the release', async () => {
    const clock = new FakeClock();
    const agent = slowAgent(clock, { fastMs: 300 });
    const h = driverHarness(clock, agent.behavior, { ttsMs: 400, playMs: 1500 });
    const t0 = await h.greet();
    h.turn.stopped('turn-1', 'rule yes');
    // The line starts synthesising at 300 ms; its audio would reach the carrier at 700 ms.
    await clock.advanceAsync(500);
    h.turn.vad('vad.start');
    h.turn.started('turn-2');
    await clock.advanceAsync(100);
    h.turn.vad('vad.stop');
    await clock.advanceAsync(5000);
    expect(h.audio.map((line) => [line.text, line.atMs - t0])).toEqual([
      ['Answer: rule yes.', 600 + REPLY_HOLD.quietMs + 400],
    ]);
    // The behaviour hears of the line once, as played: the take-back is not an interruption.
    expect(agent.receipts).toEqual([
      'completed:Hello, this is Asha.',
      'completed:Answer: rule yes.',
    ]);
    const phases = h.scheduler.history
      .filter((entry) => entry.text === 'Answer: rule yes.')
      .map((entry) => entry.phase);
    expect(phases).not.toContain('interrupted');
  });

  it('gives up on a turn that brings no words while the VAD stays on (steady noise)', async () => {
    const clock = new FakeClock();
    const agent = slowAgent(clock, { fastMs: 300 });
    const h = driverHarness(clock, agent.behavior, { ttsMs: 100, playMs: 1500 });
    const t0 = await h.greet();
    h.turn.stopped('turn-1', 'rule yes');
    await clock.advanceAsync(100);
    h.turn.vad('vad.start');
    h.turn.started('turn-2');
    await clock.advanceAsync(5000);
    expect(h.audio.map((line) => [line.text, line.atMs - t0])).toEqual([
      ['Answer: rule yes.', 100 + REPLY_HOLD.noWordsMs + 100],
    ]);
  });

  it('holds again when the words of a turn it gave up on arrive late', async () => {
    const clock = new FakeClock();
    const agent = slowAgent(clock, { llmMs: 3000 });
    const h = driverHarness(clock, agent.behavior, { ttsMs: 100, playMs: 1500 });
    const t0 = await h.greet();
    h.turn.stopped('turn-1', 'I want to pay');
    await clock.advanceAsync(100);
    h.turn.vad('vad.start');
    h.turn.started('turn-2');
    await clock.advanceAsync(200);
    h.turn.vad('vad.stop');
    // Released as noise quietMs later; the recogniser's words come 100 ms after that.
    await clock.advanceAsync(REPLY_HOLD.quietMs + 100);
    expect(h.scheduler.held).toBe(false);
    h.turn.partial('turn-2', 'next week');
    expect(h.scheduler.held).toBe(true);
    await clock.advanceAsync(1000);
    h.turn.stopped('turn-2', 'next week');
    const stopped = clock.now() - t0;
    await clock.advanceAsync(10_000);
    expect(agent.asked).toEqual(['I want to pay', 'I want to pay next week']);
    expect(h.audio.map((line) => [line.text, line.atMs - t0])).toEqual([
      ['Answer: I want to pay next week.', stopped + 3000 + 100],
    ]);
  });

  it('never waits on one caller turn longer than maxMs', async () => {
    const clock = new FakeClock();
    const agent = slowAgent(clock, { fastMs: 300 });
    const h = driverHarness(clock, agent.behavior, { ttsMs: 100, playMs: 1500 });
    const t0 = await h.greet();
    h.turn.stopped('turn-1', 'rule yes');
    await clock.advanceAsync(100);
    h.turn.vad('vad.start');
    h.turn.started('turn-2');
    h.turn.partial('turn-2', 'and another thing');
    await clock.advanceAsync(20_000);
    expect(h.audio.map((line) => [line.text, line.atMs - t0])).toEqual([
      ['Answer: rule yes.', 100 + REPLY_HOLD.maxMs + 100],
    ]);
  });

  it('keeps barge-in rules once the reply is audible: nothing is held', async () => {
    const clock = new FakeClock();
    const agent = slowAgent(clock, { fastMs: 300 });
    const h = driverHarness(clock, agent.behavior, { ttsMs: 100, playMs: 1500 });
    await h.greet();
    h.turn.stopped('turn-1', 'rule yes');
    await clock.advanceAsync(600);
    expect(h.audio.map((line) => line.text)).toEqual(['Answer: rule yes.']);
    h.turn.vad('vad.start');
    h.turn.started('turn-2');
    expect(h.scheduler.held).toBe(false);
  });

  it('holds no opening or other engine turn, only replies the caller is owed', async () => {
    const clock = new FakeClock();
    const agent = slowAgent(clock);
    const h = driverHarness(clock, agent.behavior, { ttsMs: 300, playMs: 1500 });
    h.driver.opening();
    h.turn.vad('vad.start');
    h.turn.started('turn-1');
    expect(h.scheduler.held).toBe(false);
    await clock.advanceAsync(400);
    expect(h.audio.map((line) => line.text)).toEqual(['Hello, this is Asha.']);
  });

  /**
   * Turns 5 and 6 through the default turn detector, as the engine wires it (Scribe commit, VAD):
   * the caller says `first`, pauses, and 443 ms after that final starts again with T6.
   */
  async function throughDetector(first: string) {
    const clock = new FakeClock();
    const agent = slowAgent(clock, { llmMs: LIVE.llmMs });
    const h = driverHarness(clock, agent.behavior, {
      ttsMs: 150,
      playMs: 2000,
      fillers: [FILLER.text],
    });
    const projector = new SpeechEventProjector(
      h.bus,
      new TurnLatency(clock, () => undefined),
      h.driver.turnIdForEpoch,
      () => undefined,
      h.driver.isFiller,
    );
    h.scheduler.subscribe((evidence) => projector.onSpeech(evidence));
    const detector = createTurnDetector({ filler: { lines: [FILLER.text], afterMs: 600 } }).create({
      clock,
      vad: true,
      language: 'en-IN',
      mode: 'agent',
      stt: {
        languages: ['en-IN'],
        interim: true,
        wordTimestamps: false,
        turnSignals: [],
        forceEndpoint: true,
      },
    });
    const decisions: string[] = [];
    /** When each caller turn stopped, from the greeting's end. */
    const stops: number[] = [];
    let t0 = 0;
    h.bus.onEvent((event) => detector.observe(event));
    detector.on((decision: TurnDecision) => {
      if (decision.type === 'turn.started' || decision.type === 'turn.stopped')
        decisions.push(`${decision.type} ${decision.turnId}`);
      if (decision.type === 'turn.stopped') stops.push(clock.now() - t0);
      h.driver.decide(decision);
    });
    let segment = 0;
    const heard = (text: string, stability: 'interim' | 'final') => {
      h.bus.observe({
        type: 'stt',
        atMs: clock.now(),
        event: {
          type: 'transcript',
          segment: { segmentId: `s${segment}`, revision: 1, text, stability },
        },
      } satisfies VoiceEvent);
      if (stability === 'final') {
        h.bus.observe({ type: 'stt', atMs: clock.now(), event: { type: 'end-of-turn' } });
        segment += 1;
      }
    };
    const vad = (type: 'vad.start' | 'vad.stop') => h.bus.observe({ type, atMs: clock.now() });

    t0 = await h.greet();
    vad('vad.start');
    await clock.advanceAsync(500);
    heard("Ma'am, what is this?", 'interim');
    await clock.advanceAsync(1000);
    vad('vad.stop');
    await clock.advanceAsync(100);
    heard(first, 'final');
    // The caller goes on 443 ms later; the VAD starts their next turn before any words.
    await clock.advanceAsync(LIVE.resumedMs);
    vad('vad.start');
    await clock.advanceAsync(LIVE.wordsMs - LIVE.resumedMs);
    heard('What is this? You are so', 'interim');
    await clock.advanceAsync(1700);
    vad('vad.stop');
    await clock.advanceAsync(100);
    heard(T6, 'final');
    await clock.advanceAsync(10_000);
    const at = (line: { text: string; atMs: number }) => [line.text, line.atMs - t0];
    return { agent, decisions, stops, audio: h.audio.map(at), cut: h.cut.map(at) };
  }

  it('holds through the default turn detector when the first part ended a sentence', async () => {
    const first = "Ma'am, what is this? I am so random.";
    const { agent, decisions, stops, audio, cut } = await throughDetector(first);
    expect(decisions).toEqual([
      'turn.started turn-1',
      'turn.stopped turn-1',
      'turn.started turn-2',
      'turn.stopped turn-2',
    ]);
    const merged = mergeUtterances(first, T6);
    expect(agent.asked).toEqual([first, merged]);
    // Nothing over the caller. The merged reply then gets its own filler, which it cuts (P3).
    const resumedStop = stops[1]!;
    expect(audio).toEqual([
      [FILLER.text, resumedStop + FILLER.afterMs],
      [`Answer: ${merged}.`, resumedStop + LIVE.llmMs + 150],
    ]);
    expect(cut).toEqual([[FILLER.text, resumedStop + LIVE.llmMs]]);
  });

  it('keeps the live cut-off fragment and what followed as one turn, with one reply', async () => {
    // T5 ends mid-word ("--"): the detector waits for more (wave 6 noise lane, P2), so the turn
    // that played a reply over the caller in call 8cbac365 never ends early and nothing is held.
    const { agent, decisions, stops, audio } = await throughDetector(T5);
    expect(decisions).toEqual(['turn.started turn-1', 'turn.stopped turn-1']);
    expect(agent.asked).toEqual([`${T5} ${T6}`]);
    expect(audio).toEqual([
      [FILLER.text, stops[0]! + FILLER.afterMs],
      [`Answer: ${T5} ${T6}.`, stops[0]! + LIVE.llmMs + 150],
    ]);
  });
});
