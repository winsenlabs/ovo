import { describe, expect, it } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { RecoveryState } from '../src/reprompt.ts';
import { ruledDecisionGate } from '../src/rules-gate.ts';
import { collectionsFlow, scriptedJev } from './flow-fixture.ts';

const live = () => new AbortController().signal;
const turn = (input: string) => ({ input, history: [], variables: {}, context: '' });
const config = (flow: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  AgentConfig.parse({
    name: 'Collections',
    mode: 'agent',
    variables: { type: 'object', properties: { full_name: {}, emi: {} } },
    decision: { enabled: true, flow },
    ...over,
  });

/** A gate whose flow has entered the start node and is listening for the identity reply. */
async function listening(agent: AgentConfig, port = scriptedJev([]).port) {
  const gate = ruledDecisionGate(agent, port)!;
  const first = await gate.evaluate(turn(''), live());
  if (first.kind !== 'flow') throw new Error('expected a flow step');
  gate.flow!.commit(first.step);
  return gate;
}

describe('the rules tier inside a flow (AGT-6 after AGT-1)', () => {
  it("matches the listen set's lexicon rules with no decision call, after the phrases", async () => {
    const jev = scriptedJev([]);
    const agent = config(collectionsFlow(), {
      rules: { listens: { identity: [{ intent: 'confirmed', lexicons: ['yes', 'speaking'] }] } },
    });
    const gate = await listening(agent, jev.port);
    const verdict = await gate.evaluate(turn('Haan, bol raha hoon'), live());
    expect(verdict).toMatchObject({
      kind: 'flow',
      step: { kind: 'enter', node: 'disclose', transition: { tier: 'rule', intent: 'confirmed' } },
    });
    expect(jev.requests).toHaveLength(0);
  });

  it('asks the decision model when no phrase or rule matches', async () => {
    const jev = scriptedJev([{ intent: 'asks_purpose' }]);
    const gate = await listening(config(collectionsFlow(), { rules: { global: [] } }), jev.port);
    const verdict = await gate.evaluate(turn('who is this'), live());
    expect(verdict).toMatchObject({ kind: 'flow', step: { node: 'reassure' } });
    expect(jev.requests).toHaveLength(1);
  });
});

describe('recovery for a flow that could not place the reply (AGT-4, AGT-12 after AGT-1)', () => {
  const recovery = { reprompts: { identity: 'Sorry, am I speaking with {{full_name}}?' } };

  it('re-asks the listen set the clarify fallback came from', async () => {
    const agent = config({ ...collectionsFlow(), fallback: 'clarify' }, { recovery });
    const gate = await listening(agent, scriptedJev([{ intent: 'other' }]).port);
    const verdict = await gate.evaluate(turn('hmm'), live());
    const route = new RecoveryState(agent, agent.variables).route({
      input: 'hmm',
      answered: 'Please clarify your question.',
      verdict,
      llm: false,
    });
    expect(route).toEqual({
      kind: 'recover',
      plan: {
        lines: [
          {
            field: 'recovery.reprompts.identity',
            text: 'Sorry, am I speaking with {{full_name}}?',
          },
        ],
      },
    });
  });

  it('speaks the unavailable line when the flow could not reach the decision model', async () => {
    const agent = config(collectionsFlow(), { decisionUnavailable: { line: 'One moment.' } });
    const gate = await listening(agent, scriptedJev([new Error('jev down')]).port);
    const verdict = await gate.evaluate(turn('I will pay'), live());
    expect(
      new RecoveryState(agent, agent.variables).route({ input: 'I will pay', verdict, llm: true }),
    ).toEqual({
      kind: 'recover',
      plan: { lines: [{ field: 'decisionUnavailable.line', text: 'One moment.' }] },
    });
  });

  it('leaves an llm fallback to the LLM when one is bound and nothing else is configured', async () => {
    const agent = config(collectionsFlow());
    const gate = await listening(agent, scriptedJev([{ intent: 'other' }]).port);
    const verdict = await gate.evaluate(turn('can I get a discount'), live());
    expect(
      new RecoveryState(agent, agent.variables).route({
        input: 'can I get a discount',
        verdict,
        llm: true,
      }),
    ).toEqual({ kind: 'answer' });
  });
});
