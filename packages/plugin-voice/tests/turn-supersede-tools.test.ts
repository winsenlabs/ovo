import { describe, expect, it } from 'vitest';
import { AgentConfig, type Behavior, type BehaviorEvent } from '@winsendotai/ovo-contracts';
import { AgentBehavior } from '../../behaviors/src/index.ts';
import { FakeClock } from '../../conformance/src/drivers/fake-clock.ts';
import { driverHarness, sleep } from './turn-harness.ts';

const WRITE_MS = 2000;

/** A real agent whose write tool needs a spoken confirmation and takes 2 s to run. */
function payingAgent(clock: FakeClock) {
  const effects: string[] = [];
  const asked: string[] = [];
  const behavior = new AgentBehavior(
    AgentConfig.parse({
      name: 'Agent',
      mode: 'agent',
      tools: [
        {
          id: 'pay',
          connector: 'native',
          effect: 'write',
          confirmation: true,
          description: 'Take a payment',
          inputSchema: { type: 'object' },
        },
      ],
      allowedTools: ['pay'],
    }),
    {
      generate: async (request) => {
        asked.push(request.input);
        if (request.results.length) return { kind: 'text', text: 'Paid.' };
        if (request.input.includes('pay'))
          return { kind: 'tool', toolId: 'pay', input: { amount: 500 } };
        return { kind: 'text', text: 'Anything else?' };
      },
    },
    {
      execute: async (request, options) => {
        effects.push('start');
        await sleep(clock, WRITE_MS, options?.signal);
        if (options?.signal?.aborted) {
          effects.push('aborted');
          throw options.signal.reason;
        }
        effects.push('done');
        return { ...request, state: 'succeeded', createdAt: new Date(clock.now()).toISOString() };
      },
    },
    { workspaceId: 'local', sessionId: 'call' },
  );
  return { behavior, effects, asked };
}

describe('a turn running a tool is never superseded (AGT-10)', () => {
  it('finishes a confirmed write, then answers words said while it ran', async () => {
    const clock = new FakeClock();
    const agent = payingAgent(clock);
    const h = driverHarness(clock, agent.behavior, { ttsMs: 200, playMs: 1500 });
    h.caller('pay five hundred');
    await clock.advanceAsync(3000);
    expect(h.audio.map((line) => line.text)).toEqual([expect.stringContaining('Please confirm')]);
    h.caller('yes');
    await clock.advanceAsync(800);
    // The caller adds words while the write runs, before any answer to "yes" is audible.
    h.caller('yes please go ahead');
    await clock.advanceAsync(10_000);

    expect(agent.effects).toEqual(['start', 'done']);
    expect(h.audio.slice(1).map((line) => line.text)).toEqual(['Paid.', 'Anything else?']);
    expect(agent.asked.at(-1)).toBe('yes please go ahead');
    expect(h.ended).toEqual([]);
  });

  it('never replays the words of a reply that ran a tool once a barge-in cut it off', async () => {
    const clock = new FakeClock();
    const listeners = new Set<(event: BehaviorEvent) => void>();
    const emit = (type: 'tool.started' | 'tool.settled') => {
      for (const listener of listeners) listener({ type, toolId: 'pay', operationId: 'op-1' });
    };
    const asked: string[] = [];
    const behavior: Behavior = {
      respond: async () => '',
      async *respondStream(input) {
        asked.push(input);
        emit('tool.started');
        await sleep(clock, WRITE_MS);
        emit('tool.settled');
        yield `Answer: ${input}.`;
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const h = driverHarness(clock, behavior, {
      ttsMs: 200,
      playMs: 1500,
      fillers: ['One moment.'],
    });
    h.caller('pay five hundred', { text: 'One moment.', afterMs: 600 });
    await clock.advanceAsync(1000);
    expect(h.audio.map((line) => line.text)).toEqual(['One moment.']);
    // The caller talks over the filler, then the detector drops what they said as a backchannel.
    h.driver.decide({ type: 'interrupt', reason: 'transcript' });
    h.driver.decide({ type: 'turn.reset', turnId: 'turn-2', reason: 'backchannel' });
    await clock.advanceAsync(10_000);
    expect(asked).toEqual(['pay five hundred']);
  });
});
