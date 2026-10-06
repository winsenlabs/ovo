import { describe, expect, it } from 'vitest';
import { AgentConfig, type InferenceStreamEvent } from '@winsendotai/ovo-contracts';
import { AgentBehavior } from '../src/index.ts';
import { collect, execution, llm, NOW } from './agent-call-control-fixture.ts';

const reply: InferenceStreamEvent[] = [{ kind: 'text-delta', delta: 'Okay, so your EMI is due.' }];

function agent(over: Record<string, unknown>) {
  return new AgentBehavior(
    AgentConfig.parse({ name: 'Collections', mode: 'agent', ...over }),
    llm([reply]).port,
    execution,
    { workspaceId: 'w-1', sessionId: 's-1', now: () => NOW },
  );
}

describe('per-agent first-segment pacing (LAT-9, reply.minFirstWords)', () => {
  it('keeps the default: a lone "Okay," is not cut off as its own segment', async () => {
    expect(await collect(agent({}).respondStream('when is it due?'))).toEqual([
      'Okay, so your EMI is due.',
    ]);
  });

  it("cuts the first clause at the agent's own word floor", async () => {
    expect(
      await collect(agent({ reply: { minFirstWords: 0 } }).respondStream('when is it due?')),
    ).toEqual(['Okay,', 'so your EMI is due.']);
  });
});
