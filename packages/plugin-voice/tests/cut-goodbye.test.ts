import { describe, expect, it } from 'vitest';
import type { Behavior, TurnSpeculation } from '@winsendotai/ovo-contracts';
import { FakeClock } from '../../conformance/src/drivers/fake-clock.ts';
import { driverHarness, sleep, type TestClock } from './turn-harness.ts';

/**
 * A flow's two-line do-not-call goodbye. Like the behaviors package's CallEnding, it completes
 * when the caller cuts the goodbye after hearing at least one of its lines (wave 6 P4).
 */
function goodbye(clock: TestClock): Behavior & TurnSpeculation {
  let heard = 0;
  let complete = false;
  return {
    respond: async () => '',
    async *respondStream(_input, variables = {}) {
      if (variables.inputEvent === 'opening') {
        yield 'Hello.';
        return;
      }
      await sleep(clock, 100);
      yield 'Understood, we will not call again.';
      yield 'Thank you, goodbye.';
    },
    onPlayback: (receipt) => {
      if (receipt.text === 'Hello.') return;
      if (receipt.state === 'completed') heard += 1;
      if (receipt.state === 'interrupted' && heard > 0) complete = true;
    },
    isComplete: () => complete,
    completionReason: () => 'do_not_call',
  };
}

describe('a final goodbye cut by the caller (P4)', () => {
  it('ends the call on the cut receipt, not after the caller next speaks', async () => {
    const clock = new FakeClock();
    const h = driverHarness(clock, goodbye(clock), { ttsMs: 100, playMs: 1000 });
    await h.greet();
    h.caller('please stop calling me');
    // The first line is heard from 200 ms to 1200 ms; the caller talks over the second.
    await clock.advanceAsync(1500);
    h.driver.decide({ type: 'interrupt', reason: 'transcript' });
    await clock.advanceAsync(50);
    expect(h.cut.map((line) => line.text)).toEqual(['Thank you, goodbye.']);
    expect(h.endings).toEqual(['behavior_completed:do_not_call']);
  });

  it('keeps the call open when the cut leaves the behaviour incomplete', async () => {
    const clock = new FakeClock();
    const h = driverHarness(clock, goodbye(clock), { ttsMs: 100, playMs: 1000 });
    await h.greet();
    h.caller('please stop calling me');
    // Cut before any line of the goodbye finished: the behaviour says it once more.
    await clock.advanceAsync(500);
    h.driver.decide({ type: 'interrupt', reason: 'transcript' });
    await clock.advanceAsync(50);
    expect(h.endings).toEqual([]);
  });
});
