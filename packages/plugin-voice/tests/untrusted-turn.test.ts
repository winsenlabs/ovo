import { describe, expect, it } from 'vitest';
import { UNTRUSTED_INPUT_VARIABLE, type Behavior } from '@winsendotai/ovo-contracts';
import { FakeClock } from '../../conformance/src/drivers/fake-clock.ts';
import { driverHarness } from './turn-harness.ts';

// Wave 8, call 6e1a4e3a: the turn detector now says when a caller turn's words are doubtful; the
// reply's variables carry it, so the end-call gate and the behaviour can ask again instead of
// acting on words the caller may not have said.

function recording() {
  const seen: Record<string, unknown>[] = [];
  const behavior: Behavior = {
    respond: async () => '',
    async *respondStream(_input, variables = {}) {
      if (variables.inputEvent !== 'opening') seen.push(variables);
      yield 'Okay.';
    },
  };
  return { behavior, seen };
}

describe('an untrusted caller turn (Wave 8)', () => {
  it("reaches the behaviour as the reply's untrusted-input variable, with why", async () => {
    const clock = new FakeClock();
    const agent = recording();
    const h = driverHarness(clock, agent.behavior, { ttsMs: 10, playMs: 100 });
    await h.greet();
    h.driver.decide({
      type: 'turn.stopped',
      turnId: 'turn-9',
      input: { kind: 'speech', text: 'Hardik?', segments: 1 },
      untrusted: 'low-information',
    });
    await clock.advanceAsync(500);
    h.turn.stopped('turn-10', 'Can you check flights from Chennai to Frankfurt?');
    await clock.advanceAsync(500);
    expect(agent.seen.map((v) => [v[UNTRUSTED_INPUT_VARIABLE], v.inputDoubt])).toEqual([
      [true, 'low-information'],
      [undefined, undefined],
    ]);
  });
});
