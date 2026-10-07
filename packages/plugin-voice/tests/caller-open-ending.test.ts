import { describe, expect, it } from 'vitest';
import type { Behavior, TurnSpeculation } from '@winsendotai/ovo-contracts';
import { FakeClock } from '../../conformance/src/drivers/fake-clock.ts';
import { driverHarness, sleep, type TestClock } from './turn-harness.ts';

/**
 * Maya call bcbc7d6a, turn 15: the LLM asked "what were you hoping to find out about Zagreb?" and
 * called end_call. Like the behaviors package's CallEnding, it completes once that reply has
 * played, and a later caller turn it answers takes the ending back (N1).
 */
function endsAfterReply(clock: TestClock) {
  const asked: string[] = [];
  let ending = false;
  let complete = false;
  const behavior: Behavior & TurnSpeculation = {
    respond: async () => '',
    async *respondStream(input, variables = {}) {
      if (variables.inputEvent === 'opening') {
        yield 'Hi, I am Maya.';
        return;
      }
      complete = false;
      asked.push(input);
      await sleep(clock, 100);
      ending = input.startsWith('I just want to know');
      yield ending ? 'What were you hoping to find out about Zagreb?' : `Answer: ${input}.`;
    },
    onPlayback: (receipt) => {
      if (!ending) return;
      if (receipt.state === 'completed') complete = true;
      ending = false;
    },
    isComplete: () => complete,
    completionReason: () => 'llm:end_call:Caller appears finished',
  };
  return { behavior, asked };
}

async function endingArmed() {
  const clock = new FakeClock();
  const agent = endsAfterReply(clock);
  const h = driverHarness(clock, agent.behavior, { ttsMs: 100, playMs: 1500 });
  await h.greet();
  h.turn.started('turn-15');
  h.turn.stopped('turn-15', 'I just want to know because-');
  // The reply's audio starts at 200 ms; the caller starts again while it plays ("Hello").
  await clock.advanceAsync(500);
  h.turn.started('turn-16');
  h.turn.partial('turn-16', 'Hello');
  // The reply has played to its end and the behaviour has completed.
  await clock.advanceAsync(2000);
  return { clock, h, agent };
}

describe('the call never ends on a caller who is talking (N1)', () => {
  it('waits out an open caller turn instead of hanging up when the ending settles', async () => {
    const { h } = await endingArmed();
    expect(h.endings).toEqual([]);
  });

  it("answers the caller's words, and the ending they spoke over does not survive", async () => {
    const { clock, h, agent } = await endingArmed();
    h.turn.stopped('turn-16', 'Hello');
    await clock.advanceAsync(3000);
    expect(agent.asked).toEqual(['I just want to know because-', 'Hello']);
    expect(h.endings).toEqual([]);
  });

  it('ends once the open turn turns out to be no turn (a backchannel, noise)', async () => {
    const { clock, h } = await endingArmed();
    h.turn.reset('turn-16');
    await clock.advanceAsync(10);
    expect(h.endings).toEqual(['behavior_completed:llm:end_call:Caller appears finished']);
  });

  it('ends as soon as the goodbye has played when the caller is quiet', async () => {
    const clock = new FakeClock();
    const h = driverHarness(clock, endsAfterReply(clock).behavior, { ttsMs: 100, playMs: 1500 });
    await h.greet();
    h.turn.started('turn-15');
    h.turn.stopped('turn-15', 'I just want to know because-');
    await clock.advanceAsync(1700);
    expect(h.endings).toEqual(['behavior_completed:llm:end_call:Caller appears finished']);
  });
});
