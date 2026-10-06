import { describe, expect, it } from 'vitest';
import type { CompatInput } from '../src/compat/index.ts';
import { speculativeLlmUnpriced } from '../src/compat/speculative-llm-unpriced.ts';
import { fixture, withConfig } from './compat-support.ts';

const agent = {
  mode: 'agent',
  decision: {
    enabled: true,
    questions: [
      {
        type: 'choice',
        id: 'intent',
        instructions: 'What does the caller want?',
        threshold: 0.8,
        fallback: 'llm',
        options: [
          { key: 'pay', description: 'Pays now', outcome: { say: 'Sending the link.' } },
          { key: 'other', description: 'Anything else', outcome: {} },
        ],
      },
    ],
  },
};

/** `decision.speculation` is set after parsing until the contract carries it (cross-lane). */
function speculating(llm: boolean, priceCards?: CompatInput['priceCards']): CompatInput {
  const input = withConfig(fixture(), agent);
  (input.config.decision as unknown as { speculation: object }).speculation = { llm };
  if (priceCards) input.priceCards = priceCards;
  return input;
}

describe('speculative LLM pricing (LAT-3)', () => {
  it('warns at every stage while the LLM has no confirmed price', () => {
    for (const stage of ['release', 'live', 'test'] as const)
      expect(speculativeLlmUnpriced(speculating(true), stage)).toEqual([
        expect.objectContaining({
          code: 'meter_uncovered',
          severity: 'warning',
          stage,
          slot: 'llm',
          pluginId: 'llm',
          field: 'decision.speculation.llm',
          message: expect.stringContaining('llm.usage'),
        }),
      ]);
  });

  it('treats a provisional card as no price', () => {
    const provisional = { 'llm.usage': { id: 'luna', version: '1', provisional: true } };
    expect(speculativeLlmUnpriced(speculating(true, provisional), 'live')).toHaveLength(1);
  });

  it('is quiet once the LLM has a confirmed price, or the agent does not speculate', () => {
    const confirmed = { 'llm.usage': { id: 'luna', version: '2', provisional: false } };
    expect(speculativeLlmUnpriced(speculating(true, confirmed), 'live')).toEqual([]);
    expect(speculativeLlmUnpriced(speculating(false), 'live')).toEqual([]);
    expect(speculativeLlmUnpriced(withConfig(fixture(), agent), 'live')).toEqual([]);
  });

  it('warns about a missing LLM selection rather than pass it silently', () => {
    const input = speculating(true);
    input.selections = { ...input.selections, llm: undefined };
    expect(speculativeLlmUnpriced(input, 'live')).toEqual([
      expect.objectContaining({ severity: 'warning', message: expect.stringContaining('LLM') }),
    ]);
  });
});
