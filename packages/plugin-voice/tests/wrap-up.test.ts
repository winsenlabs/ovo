import { describe, expect, it } from 'vitest';
import type { Behavior, EngineEvent, TurnSpeculation } from '@winsendotai/ovo-contracts';
import { AgentEnding } from '@winsendotai/ovo-contracts';
import { createFakeCarrier } from '../../conformance/src/drivers/fake-carrier.ts';
import { FakeClock, flushMicrotasks } from '../../conformance/src/drivers/fake-clock.ts';
import { NativeVoiceSessionEngine } from '../src/engine/session-engine.ts';
import { BoundedSpeechScheduler } from '../src/scheduler.ts';
import { driverHarness, sleep, type TestClock } from './turn-harness.ts';

const GOODBYE = 'We have to end the call here. Thank you for your time, goodbye.';

/** Answers every caller turn with two lines after `ms`, as a flow node does. */
function twoLines(clock: TestClock, ms = 300): Behavior & TurnSpeculation {
  return {
    respond: async () => '',
    async *respondStream(_input, variables = {}) {
      if (variables.inputEvent === 'opening') {
        yield 'Hello.';
        return;
      }
      await sleep(clock, ms);
      yield 'Your EMI was due on the 25th.';
      yield 'Can you pay it this week?';
    },
  };
}

describe('graceful max-duration wrap-up', () => {
  it('lets the line being heard finish, drops the rest, says goodbye and ends completed', async () => {
    const clock = new FakeClock();
    const h = driverHarness(clock, twoLines(clock), { ttsMs: 100, playMs: 2000 });
    const t0 = await h.greet();
    h.caller('when is it due');
    // The first line is heard from 400 ms to 2400 ms; the limit's lead arrives mid-line.
    await clock.advanceAsync(900);
    h.driver.wrapUp(GOODBYE, 5000);
    // Words said now are not taken as a turn: the call is closing.
    h.caller('wait, one more thing');
    await clock.advanceAsync(10_000);
    expect(h.audio.map((line) => [line.text, line.atMs - t0])).toEqual([
      ['Your EMI was due on the 25th.', 400],
      [GOODBYE, 2400 + 100],
    ]);
    expect(h.cut).toEqual([]);
    expect(h.endings).toEqual(['behavior_completed:max_duration']);
  });

  it('cuts a line still playing after finishMs rather than overrun the limit', async () => {
    const clock = new FakeClock();
    const h = driverHarness(clock, twoLines(clock), { ttsMs: 100, playMs: 20_000 });
    const t0 = await h.greet();
    h.caller('when is it due');
    await clock.advanceAsync(900);
    h.driver.wrapUp(GOODBYE, 5000);
    await clock.advanceAsync(30_000);
    expect(h.cut.map((line) => [line.text, line.atMs - t0])).toEqual([
      ['Your EMI was due on the 25th.', 5900],
    ]);
    expect(h.audio.at(-1)).toMatchObject({ text: GOODBYE, atMs: t0 + 5900 + 100 });
    expect(h.endings).toEqual(['behavior_completed:max_duration']);
  });

  it('runs leadSeconds before maxCallSeconds on the engine clock', async () => {
    const clock = new FakeClock();
    const carrier = createFakeCarrier({ clock });
    const spoken: { text: string; atMs: number }[] = [];
    const engine = new NativeVoiceSessionEngine({
      clock,
      media: carrier.duplex,
      behavior: { respond: async () => '' },
      scheduler: new BoundedSpeechScheduler({
        async play(segment) {
          spoken.push({ text: segment.text, atMs: clock.now() });
          return { state: 'completed', evidence: 'confirmed' };
        },
        async interrupt() {},
      }),
      session: {
        mode: 'agent',
        language: 'en-IN',
        inputEnabled: false,
        variables: {},
        maxCallSeconds: 30,
        acknowledgements: [],
      },
      engine: { wrapUp: { line: GOODBYE, leadSeconds: 10 } },
    });
    const events: EngineEvent[] = [];
    engine.subscribe((event) => events.push(event));
    const t0 = clock.now();
    await engine.start();
    await clock.advanceAsync(19_999);
    expect(spoken).toEqual([]);
    await clock.advanceAsync(1);
    await flushMicrotasks();
    expect(await engine.ended).toEqual({ reason: 'behavior_completed', outcome: 'completed' });
    expect(spoken).toEqual([{ text: GOODBYE, atMs: t0 + 20_000 }]);
    expect(events).toContainEqual({
      type: 'end',
      reason: 'behavior_completed',
      detail: 'max_duration',
    });
  });

  it('is configured on the agent as a fixed line with a default lead', () => {
    expect(AgentEnding.parse({ wrapUp: { line: GOODBYE } })).toEqual({
      llmTool: false,
      wrapUp: { line: GOODBYE, leadSeconds: 15 },
    });
    expect(AgentEnding.safeParse({ wrapUp: { line: 'Bye {{name}}.' } }).success).toBe(false);
    expect(AgentEnding.safeParse({ wrapUp: { line: GOODBYE, leadSeconds: 2 } }).success).toBe(
      false,
    );
  });
});
