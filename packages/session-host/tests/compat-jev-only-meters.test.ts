import { describe, expect, it } from 'vitest';
import { validateSelections, type CompatInput } from '../src/compat/index.ts';
import { fixture, withConfig } from './compat-support.ts';

const jevOnly = {
  mode: 'agent',
  decision: {
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
          { key: 'bye', description: 'Goodbye', outcome: { say: 'Goodbye.', end: true } },
        ],
      },
    ],
    state: { sources: ['last-turn'] },
  },
  decisionUnavailable: { line: 'Sorry, one moment.' },
};
const llmMeters = (input: CompatInput) => {
  input.selections = { ...input.selections, llm: undefined };
  return validateSelections(input, 'live').filter(
    (issue) => issue.code === 'meter_uncovered' && issue.slot === 'llm',
  );
};

describe('meter coverage for a Jev-only agent (AGT-4)', () => {
  it('does not ask for an LLM price card when no path reaches an LLM', () => {
    expect(llmMeters(withConfig(fixture(), jevOnly))).toEqual([]);
  });

  it('still asks for one when a path reaches the LLM', () => {
    expect(llmMeters(withConfig(fixture(), { mode: 'agent' }))).toEqual([
      expect.objectContaining({ field: 'llm', severity: 'error' }),
    ]);
  });
});
