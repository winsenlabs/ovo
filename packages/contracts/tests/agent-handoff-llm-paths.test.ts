import { describe, expect, it } from 'vitest';
import { AgentConfig, agentLlmPaths } from '../src/index.ts';

const policy = {
  enabled: true,
  questions: [
    {
      type: 'choice',
      id: 'intent',
      instructions: 'What does the caller want?',
      threshold: 0.7,
      fallback: 'clarify',
      options: [
        { key: 'pay', description: 'Will pay', outcome: { say: 'Thank you.' } },
        { key: 'bye', description: 'Wants to go', outcome: { say: 'Goodbye.', end: true } },
      ],
    },
  ],
  state: { sources: ['last-turn'] },
};

describe('a transfer on an unavailable decision keeps an agent Jev-only (AGT-15)', () => {
  it('needs no LLM for an unavailable verdict that transfers', () => {
    const transfer = (onDecisionUnavailable: boolean) =>
      agentLlmPaths(
        AgentConfig.parse({
          name: 'Collections',
          mode: 'agent',
          decision: policy,
          handoff: {
            transfer: { target: { kind: 'queue', name: 'agents' }, onDecisionUnavailable },
          },
        }),
      );
    expect(transfer(true)).toEqual([]);
    expect(transfer(false)).toEqual(['decisionUnavailable']);
  });
});
