import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../conformance/src/drivers/fake-clock.ts';
import { driverHarness, slowAgent } from './turn-harness.ts';

const LLM_MS = 2500;
const TTS_MS = 200;
const FILLER = { text: 'One moment.', afterMs: 600 };

function setup(llmMs = LLM_MS, ttsMs = TTS_MS) {
  const clock = new FakeClock();
  const agent = slowAgent(clock, { llmMs });
  // The filler is a pre-rendered clip: its audio starts without a synthesis wait.
  const h = driverHarness(clock, agent.behavior, { ttsMs, playMs: 1500, fillers: [FILLER.text] });
  return { clock, agent, h };
}

describe('pre-rendered filler on slow replies (LAT-6)', () => {
  it('cuts the silence before a slow LLM reply from 2.7 s to 0.6 s', async () => {
    const without = setup();
    const t0 = await without.h.greet();
    without.h.caller('what is my balance');
    await without.clock.advanceAsync(10_000);
    const silentFor = without.h.audio[0]!.atMs - t0;

    const withFiller = setup();
    const t1 = await withFiller.h.greet();
    withFiller.h.caller('what is my balance', FILLER);
    await withFiller.clock.advanceAsync(10_000);
    const audio = withFiller.h.audio;

    expect(silentFor).toBe(LLM_MS + TTS_MS);
    expect(audio.map((line) => [line.text, line.atMs - t1, line.kind])).toEqual([
      ['One moment.', 600, 'acknowledgment'],
      ['Answer: what is my balance.', LLM_MS + TTS_MS, 'response'],
    ]);
    // The filler is not part of the conversation the behaviour records.
    expect(withFiller.agent.receipts).toEqual([
      'completed:Hello, this is Asha.',
      'completed:Answer: what is my balance.',
    ]);
  });

  it('never plays on a fast rules or decision reply', async () => {
    const { clock, h } = setup();
    await h.greet();
    h.caller('rule yes', FILLER);
    await clock.advanceAsync(10_000);
    expect(h.audio.map((line) => line.text)).toEqual(['Answer: rule yes.']);
  });

  it('never plays once the reply has its first line, however slow its synthesis', async () => {
    const { clock, h } = setup(300, 1000);
    const t0 = await h.greet();
    h.caller('what is my balance', FILLER);
    await clock.advanceAsync(10_000);
    expect(h.audio.map((line) => [line.text, line.atMs - t0])).toEqual([
      ['Answer: what is my balance.', 1300],
    ]);
  });

  it('plays at most once for the caller words, even when a barge-in merges them', async () => {
    const { clock, agent, h } = setup();
    await h.greet();
    h.caller('I want to pay', FILLER);
    await clock.advanceAsync(1000);
    // The caller talks over the filler: it is cut off, and the question is still unanswered.
    h.driver.decide({ type: 'interrupt', reason: 'transcript' });
    await clock.advanceAsync(200);
    h.caller('for tomorrow please', { text: 'Let me check.', afterMs: 600 });
    await clock.advanceAsync(10_000);
    expect(agent.asked).toEqual(['I want to pay', 'I want to pay for tomorrow please']);
    expect(h.audio.map((line) => line.text)).toEqual([
      'One moment.',
      'Answer: I want to pay for tomorrow please.',
    ]);
  });

  it('plays on the merged turn when the caller adds words before it is due', async () => {
    const { clock, agent, h } = setup();
    const t0 = await h.greet();
    h.caller('I want to pay', FILLER);
    await clock.advanceAsync(400);
    h.caller('tomorrow', FILLER);
    await clock.advanceAsync(10_000);
    expect(agent.asked).toEqual(['I want to pay', 'I want to pay tomorrow']);
    expect(h.audio.map((line) => [line.text, line.atMs - t0])).toEqual([
      ['One moment.', 1000],
      ['Answer: I want to pay tomorrow.', 400 + LLM_MS + TTS_MS],
    ]);
  });
});
