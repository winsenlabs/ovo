import { describe, expect, it } from 'vitest';
import type { VoiceEvent } from '@winsendotai/ovo-contracts';
import { FakeClock } from '../../conformance/src/drivers/fake-clock.ts';
import { createTurnDetector } from '../../plugin-turns/src/index.ts';
import { TurnLatency } from '../src/engine/latency.ts';
import { SpeechEventProjector } from '../src/engine/speech-events.ts';
import { driverHarness, slowAgent } from './turn-harness.ts';

const FILLER = 'One moment.';

/** Detector, projector and driver wired as the native engine wires them. */
function engine() {
  const clock = new FakeClock();
  const agent = slowAgent(clock, { llmMs: 2500 });
  const h = driverHarness(clock, agent.behavior, { ttsMs: 200, playMs: 1500, fillers: [FILLER] });
  const latency = new TurnLatency(clock, () => undefined);
  const projector = new SpeechEventProjector(
    h.bus,
    latency,
    h.driver.turnIdForEpoch,
    () => undefined,
    h.driver.isFiller,
  );
  h.scheduler.subscribe((evidence) => projector.onSpeech(evidence));
  const detector = createTurnDetector({ filler: { lines: [FILLER], afterMs: 600 } }).create({
    clock,
    vad: false,
    language: 'en-IN',
    mode: 'agent',
  });
  const bot: string[] = [];
  h.bus.onEvent((event) => {
    if (event.type === 'bot.started') bot.push(`${event.kind}${event.filler ? ' filler' : ''}`);
    detector.observe(event);
  });
  detector.on((decision) => h.driver.decide(decision));
  let segment = 0;
  const say = (text: string) => {
    const atMs = clock.now();
    const id = `s${++segment}`;
    h.bus.observe({
      type: 'stt',
      atMs,
      event: {
        type: 'transcript',
        segment: { segmentId: id, revision: 1, text, stability: 'final' },
      },
    } satisfies VoiceEvent);
    h.bus.observe({ type: 'stt', atMs, event: { type: 'end-of-turn' } });
  };
  return { clock, agent, h, say, bot };
}

describe('a short continuation said over a filler (LAT-6 with AGT-9 and AGT-10)', () => {
  it('is merged into the reply instead of being dropped as a backchannel', async () => {
    const { clock, agent, h, say, bot } = engine();
    await h.greet();
    say('my name is');
    // The filler is due 600 ms into the turn; the caller finishes the sentence while it plays.
    await clock.advanceAsync(1000);
    expect(h.audio.map((line) => line.text)).toEqual([FILLER]);
    say('Tejas');
    await clock.advanceAsync(10_000);

    expect(agent.asked).toEqual(['my name is', 'my name is Tejas']);
    expect(h.audio.map((line) => line.text)).toEqual([FILLER, 'Answer: my name is Tejas.']);
    expect(bot).toEqual(['response', 'acknowledgment filler', 'response']);
  });

  it('lets a backchannel acknowledge the filler without restarting the reply', async () => {
    const { clock, agent, h, say } = engine();
    await h.greet();
    say('what is my balance');
    await clock.advanceAsync(1000);
    say('ok');
    await clock.advanceAsync(10_000);
    expect(agent.asked).toEqual(['what is my balance']);
    expect(agent.cancels()).toBe(0);
    expect(h.audio.map((line) => line.text)).toEqual([FILLER, 'Answer: what is my balance.']);
  });
});
