import { describe, expect, it } from 'vitest';
import type { Behavior, TurnSpeculation } from '@winsendotai/ovo-contracts';
import { FakeClock } from '../../conformance/src/drivers/fake-clock.ts';
import { driverHarness, sleep, slowAgent } from './turn-harness.ts';

/**
 * P3, from call 8cbac365 (2026-10-07), turn 2, times relative to the turn stopping at
 * 13:06:04.289: the filler "Sure, let me check that." (a cached clip) started at 592 ms and played
 * to 2266 ms; the reply "I'm not sure about that." was ready at 1134 ms (its synthesis took 138 ms)
 * and waited behind the whole filler.
 */
const FILLER = { text: 'Sure, let me check that.', afterMs: 600 };
const LIVE = { replyMs: 1134, ttsMs: 138, fillerPlayMs: 1674 };

describe('the reply preempts its filler (P3)', () => {
  it('cuts the playing filler when the first line is ready, 1.1 s sooner than the live call', async () => {
    const clock = new FakeClock();
    const agent = slowAgent(clock, { llmMs: LIVE.replyMs });
    const epochs: number[] = [];
    const receiptEpochs: Record<string, number> = {};
    const onPlayback = agent.behavior.onPlayback!;
    agent.behavior.beginTurn = (epoch) => epochs.push(epoch);
    agent.behavior.onPlayback = (receipt) => {
      receiptEpochs[receipt.text] = receipt.epoch;
      return onPlayback(receipt);
    };
    const h = driverHarness(clock, agent.behavior, {
      ttsMs: LIVE.ttsMs,
      playMs: LIVE.fillerPlayMs,
      fillers: [FILLER.text],
    });
    const t0 = await h.greet();
    h.caller('when is it due', FILLER);
    await clock.advanceAsync(10_000);

    const reply = 'Answer: when is it due.';
    expect(h.audio.map((line) => [line.text, line.atMs - t0])).toEqual([
      [FILLER.text, FILLER.afterMs],
      [reply, LIVE.replyMs + LIVE.ttsMs],
    ]);
    expect(h.cut.map((line) => [line.text, line.atMs - t0])).toEqual([[FILLER.text, LIVE.replyMs]]);
    // Live, the reply was heard once the filler ended: 2266 + 138 ms.
    const live = FILLER.afterMs + LIVE.fillerPlayMs + LIVE.ttsMs;
    expect(live - (LIVE.replyMs + LIVE.ttsMs)).toBe(1140);
    // The behaviour hears of its line under the epoch it began, though it played in the next one.
    const turnEpoch = epochs.at(-1)!;
    expect(receiptEpochs[reply]).toBe(turnEpoch);
    const played = h.scheduler.history.find((entry) => entry.text === reply)!;
    expect(played.epoch).toBe(turnEpoch + 1);
    expect(agent.receipts.at(-1)).toBe(`completed:${reply}`);
    expect(agent.receipts.some((receipt) => receipt.includes(FILLER.text))).toBe(false);
  });

  it('keeps every line of a streamed reply, in order, after the cut', async () => {
    const clock = new FakeClock();
    const behavior: Behavior & TurnSpeculation = {
      respond: async () => '',
      async *respondStream(_input, variables = {}) {
        if (variables.inputEvent === 'opening') {
          yield 'Hello.';
          return;
        }
        await sleep(clock, 1000);
        yield 'First line.';
        yield 'Second line.';
      },
    };
    const h = driverHarness(clock, behavior, { ttsMs: 100, playMs: 500, fillers: [FILLER.text] });
    const t0 = await h.greet();
    h.caller('what is the amount', FILLER);
    await clock.advanceAsync(10_000);
    expect(h.audio.map((line) => [line.text, line.atMs - t0])).toEqual([
      [FILLER.text, 600],
      ['First line.', 1100],
      ['Second line.', 1700],
    ]);
    expect(h.ended).toEqual([]);
  });

  it('leaves a filler that has finished alone', async () => {
    const clock = new FakeClock();
    const agent = slowAgent(clock, { llmMs: 2500 });
    const h = driverHarness(clock, agent.behavior, {
      ttsMs: 200,
      playMs: 1000,
      fillers: [FILLER.text],
    });
    const t0 = await h.greet();
    h.caller('what is my balance', FILLER);
    await clock.advanceAsync(10_000);
    expect(h.cut).toEqual([]);
    expect(h.audio.map((line) => [line.text, line.atMs - t0])).toEqual([
      [FILLER.text, 600],
      ['Answer: what is my balance.', 2700],
    ]);
  });
});
