import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../conformance/src/drivers/fake-clock.ts';
import { mergeUtterances } from '../src/engine/turn-speculation.ts';
import { driverHarness, slowAgent } from './turn-harness.ts';

const LLM_MS = 2500;
const TTS_MS = 200;
const PLAY_MS = 1500;

describe('a stale turn is cancelled when the caller speaks again while it thinks (AGT-10)', () => {
  it('answers a follow-up during the LLM wait with one merged reply, 3.2 s sooner', async () => {
    const clock = new FakeClock();
    const agent = slowAgent(clock, { llmMs: LLM_MS });
    const h = driverHarness(clock, agent.behavior, { ttsMs: TTS_MS, playMs: PLAY_MS });
    const t0 = await h.greet();
    h.caller('I want to pay');
    await clock.advanceAsync(1000);
    h.caller('tomorrow');
    const lastWords = clock.now();
    await clock.advanceAsync(10_000);

    expect(agent.asked).toEqual(['I want to pay', 'I want to pay tomorrow']);
    expect(agent.cancels()).toBe(1);
    // The stale answer never plays: one reply, to everything the caller said.
    expect(h.audio.map((line) => line.text)).toEqual(['Answer: I want to pay tomorrow.']);
    const answeredAfter = h.audio[0]!.atMs - lastWords;
    expect(answeredAfter).toBe(LLM_MS + TTS_MS);
    // Serially the stale answer played first (at t0 + 2.7 s, for 1.5 s), then the follow-up's own
    // LLM and TTS: the caller's last words waited 5.9 s for an answer to them.
    const serial = LLM_MS + TTS_MS + PLAY_MS + LLM_MS + TTS_MS - (lastWords - t0);
    expect(serial).toBe(5900);
    expect(serial - answeredAfter).toBe(3200);
  });

  it('cancels the stale line during its TTS wait, so its audio never reaches the caller', async () => {
    const clock = new FakeClock();
    const agent = slowAgent(clock, { llmMs: 500 });
    const h = driverHarness(clock, agent.behavior, { ttsMs: 800, playMs: PLAY_MS });
    await h.greet();
    h.caller('my loan number is');
    // The answer's text exists at 500 ms; its synthesis would finish at 1300 ms.
    await clock.advanceAsync(900);
    h.caller('four two seven');
    await clock.advanceAsync(10_000);
    expect(agent.asked).toEqual(['my loan number is', 'my loan number is four two seven']);
    expect(h.audio.map((line) => line.text)).toEqual(['Answer: my loan number is four two seven.']);
    expect(agent.receipts).toContain('interrupted:Answer: my loan number is.');
  });

  it('keeps barge-in rules once the answer is audible: the next words are a new turn', async () => {
    const clock = new FakeClock();
    const agent = slowAgent(clock, { llmMs: LLM_MS });
    const h = driverHarness(clock, agent.behavior, { ttsMs: TTS_MS, playMs: PLAY_MS });
    await h.greet();
    h.caller('what is my balance');
    await clock.advanceAsync(LLM_MS + TTS_MS + 100);
    expect(h.audio.map((line) => line.text)).toEqual(['Answer: what is my balance.']);
    h.caller('and the due date');
    await clock.advanceAsync(10_000);
    expect(agent.asked).toEqual(['what is my balance', 'and the due date']);
    expect(agent.cancels()).toBe(0);
  });

  it('merges words said while an answer plays into one queued turn', async () => {
    const clock = new FakeClock();
    const agent = slowAgent(clock, { llmMs: 300 });
    const h = driverHarness(clock, agent.behavior, { ttsMs: TTS_MS, playMs: 5000 });
    await h.greet();
    h.caller('hello');
    await clock.advanceAsync(600);
    h.caller('I got your message');
    await clock.advanceAsync(500);
    h.caller('about the payment');
    await clock.advanceAsync(20_000);
    expect(agent.asked).toEqual(['hello', 'I got your message about the payment']);
  });

  it('never merges a key press with speech', async () => {
    const clock = new FakeClock();
    const agent = slowAgent(clock, { llmMs: LLM_MS });
    const h = driverHarness(clock, agent.behavior, { ttsMs: TTS_MS, playMs: PLAY_MS });
    await h.greet();
    h.caller('rule repeat that');
    h.driver.decide({
      type: 'turn.stopped',
      turnId: 'dtmf-1',
      input: { kind: 'dtmf', digits: '1' },
    });
    await clock.advanceAsync(10_000);
    expect(agent.asked).toEqual(['rule repeat that', '1']);
  });

  it('tells a speculating behaviour what to prepare, drop and finalise (LAT-4 hook)', async () => {
    const clock = new FakeClock();
    const agent = slowAgent(clock, { llmMs: LLM_MS });
    const h = driverHarness(clock, agent.behavior, { ttsMs: TTS_MS, playMs: PLAY_MS });
    await h.greet();
    h.driver.decide({ type: 'turn.partial', turnId: 'turn-1', text: 'I want', stable: false });
    h.caller('I want to pay');
    await clock.advanceAsync(1000);
    h.driver.decide({ type: 'turn.partial', turnId: 'turn-2', text: 'tomorrow', stable: true });
    h.caller('tomorrow');
    await clock.advanceAsync(10_000);
    h.driver.decide({ type: 'turn.reset', turnId: 'turn-3', reason: 'backchannel' });
    expect(agent.hooks).toEqual([
      'prepare turn-1 I want',
      'finalize turn-1 I want to pay merged=false',
      'prepare turn-2 tomorrow',
      'discard turn-1 superseded',
      'finalize turn-2 I want to pay tomorrow merged=true',
      'discard turn-3 reset',
    ]);
  });

  it('ignores a speculation hook that throws', async () => {
    const clock = new FakeClock();
    const agent = slowAgent(clock, { llmMs: 100 });
    agent.behavior.finalize = () => {
      throw new Error('speculation bug');
    };
    const h = driverHarness(clock, agent.behavior, { ttsMs: TTS_MS, playMs: PLAY_MS });
    await h.greet();
    h.caller('hello');
    await clock.advanceAsync(5000);
    expect(h.audio.map((line) => line.text)).toEqual(['Answer: hello.']);
    expect(h.ended).toEqual([]);
  });
});

describe('mergeUtterances', () => {
  it.each([
    ['I want to pay', 'tomorrow', 'I want to pay tomorrow'],
    ['I want to pay', 'I want to pay tomorrow', 'I want to pay tomorrow'],
    ['I want to pay tomorrow', 'tomorrow', 'I want to pay tomorrow'],
    ['haan', 'haan', 'haan'],
    ['', 'yes', 'yes'],
  ])('%s + %s = %s', (earlier, later, merged) => {
    expect(mergeUtterances(earlier, later)).toBe(merged);
  });
});
