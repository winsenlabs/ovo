import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { DEFAULT_SPECULATION, speculationPolicy } from '../src/index.ts';
import { RuledDecisionGate } from '../src/rules-gate.ts';
import { AgentSpeculation } from '../src/speculation-agent.ts';
import { atPayment, flowAgent, slowJev } from './speculation-fixture.ts';

const decision = (sources: string[]) => ({
  enabled: true,
  questions: [
    {
      type: 'choice',
      id: 'intent',
      instructions: 'What does the caller want?',
      threshold: 0.8,
      fallback: 'llm',
      options: [
        { key: 'pay', description: 'Pays now', outcome: {} },
        { key: 'other', description: 'Anything else', outcome: {} },
      ],
    },
  ],
  state: { sources },
});

describe('the speculation policy', () => {
  it('decides on partials and asks the LLM alongside unless an agent says otherwise', () => {
    expect(DEFAULT_SPECULATION).toEqual({
      partials: true,
      debounceMs: 150,
      match: 'exact',
      llm: true,
    });
    expect(speculationPolicy(undefined)).toEqual(DEFAULT_SPECULATION);
    // `decision.speculation`, then the override.
    expect(
      speculationPolicy({ speculation: { llm: false, debounceMs: 80 } }, { debounceMs: undefined }),
    ).toEqual({ ...DEFAULT_SPECULATION, llm: false, debounceMs: 80 });
    expect(speculationPolicy({ speculation: { llm: true } }, { llm: false }).llm).toBe(false);
  });

  it('does not decide partials for an agent whose decision reads retrieved passages', () => {
    const knowledge = { enabled: true, minScore: 0.4, topK: 3 };
    const reads = AgentConfig.parse({
      name: 'A',
      mode: 'agent',
      knowledge,
      decision: decision(['last-turn', 'knowledge']),
    });
    const ignores = AgentConfig.parse({
      name: 'A',
      mode: 'agent',
      knowledge,
      decision: decision(['last-turn']),
    });
    expect(AgentSpeculation.forGate(reads, DEFAULT_SPECULATION).partials).toBe(false);
    expect(AgentSpeculation.forGate(ignores, DEFAULT_SPECULATION).partials).toBe(true);
  });
});

describe('cancelling a turn', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts no decision for a partial still waiting out its debounce', async () => {
    const jev = slowJev({});
    const agent = flowAgent(jev.port);
    await atPayment(agent);
    agent.prepare({ turnId: 't-3', text: 'kal kar dunga', stable: false });
    agent.cancel('caller barged in');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(jev.requests).toHaveLength(0);
  });

  it('does not speculate, and still decides, when the variables cannot be compared', async () => {
    const jev = slowJev({});
    const parsed = AgentConfig.parse({
      name: 'A',
      mode: 'agent',
      decision: decision(['last-turn']),
    });
    const gate = new RuledDecisionGate(parsed.decision!, jev.port, undefined, undefined, {
      ...DEFAULT_SPECULATION,
      debounceMs: 0,
    });
    const turn = { input: 'hello', history: [], variables: { balance: 10n }, context: '' };
    gate.prepare('t-1', turn, true);
    expect(jev.requests).toHaveLength(0);
    const verdict = gate.evaluate(turn, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await verdict).toMatchObject({ kind: 'decided' });
    expect(jev.requests).toHaveLength(1);
  });
});

describe('the authored flag (integration)', () => {
  it('reads `decision.speculation` from the agent config', () => {
    const config = AgentConfig.parse({
      name: 'A',
      mode: 'agent',
      decision: { ...decision(['last-turn']), speculation: { llm: true, match: 'prefix' } },
    });
    expect(new AgentSpeculation(config).policy).toEqual({
      ...DEFAULT_SPECULATION,
      llm: true,
      match: 'prefix',
    });
    expect(() =>
      AgentConfig.parse({
        name: 'A',
        mode: 'agent',
        decision: { ...decision(['last-turn']), speculation: { llm: 'yes' } },
      }),
    ).toThrow();
  });
});
