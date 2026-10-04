import { describe, expect, it } from 'vitest';
import { Cap, type ReleaseSelections } from '@winsendotai/ovo-contracts';
import { definePlugin, PluginRegistry } from '@winsendotai/ovo-runtime';
import { validateSelections } from '../src/compat/index.ts';
import { codes, fixture, withConfig } from './compat-support.ts';

const question = {
  type: 'choice' as const,
  id: 'intent',
  instructions: 'What does the caller want?',
  threshold: 0.8,
  fallback: 'llm' as const,
  options: [
    { key: 'pay', description: 'Wants to pay now', outcome: { say: 'Sending a link.' } },
    { key: 'other', description: 'Anything else', outcome: {} },
  ],
};

const policy = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  questions: [question],
  state: { sources: ['last-turn'] },
  ...over,
});

const decisionCapabilities = {
  primitives: ['choice', 'noul', 'score'],
  maxCriteria: 8,
  maxQuestionsPerRequest: 4,
  languages: ['en-IN'],
  calibration: { label: 'cohort-a', source: 'vendor-published' },
};

/** The decision slot is not part of the shared fixture, so each case opts in explicitly. */
function withDecision(capabilities: Record<string, unknown> = {}) {
  const input = fixture();
  const plugin = definePlugin(
    {
      id: 'decider',
      version: '1.0.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'decision',
      provider: 'decider',
      provides: [Cap.decision],
      capabilities: { ...decisionCapabilities, ...capabilities },
      conformance: ['decision@1'],
      meters: [
        { key: 'decision.usage', unit: 'input_tokens', label: 'Decisions', role: 'decision' },
      ],
      runtime: { egressHosts: [], modelLicences: [] },
    } as never,
    () => undefined,
  );
  input.registry = new PluginRegistry([...input.registry.list(), plugin]);
  input.selections = {
    ...input.selections,
    decision: { pluginId: 'decider', version: '1.0.0', config: {} },
  } as ReleaseSelections;
  input.priceCards = { ...input.priceCards, 'decision.usage': {} };
  input.fixturePluginIds = [...(input.fixturePluginIds ?? []), 'decider'];
  return input;
}

describe('a decision policy without a plugin', () => {
  it('blocks the release', () => {
    const input = withConfig(fixture(), { mode: 'agent', decision: policy() });
    expect(codes(input, 'release')).toContain('decision_plugin_missing');
    const reported = validateSelections(input, 'release').find(
      (entry) => entry.code === 'decision_plugin_missing',
    )!;
    expect(reported.severity).toBe('error');
    expect(reported.slot).toBe('decision');
    expect(reported.message).toContain('1 decision question');
  });

  it('says nothing when the policy is present but disabled', () => {
    const input = withConfig(fixture(), {
      mode: 'agent',
      decision: policy({ enabled: false }),
    });
    expect(codes(input, 'release')).not.toContain('decision_plugin_missing');
  });

  it('says nothing for an agent with no policy at all', () => {
    expect(codes(withConfig(fixture(), { mode: 'agent' }), 'release')).not.toContain(
      'decision_plugin_missing',
    );
  });
});

describe('a decision plugin nobody asks', () => {
  it('warns rather than blocking, because the cost is wasted but the call is sound', () => {
    const input = withConfig(withDecision(), { mode: 'agent' });
    const reported = validateSelections(input, 'release').find(
      (entry) => entry.code === 'decision_plugin_unused',
    )!;
    expect(reported.severity).toBe('warning');
    expect(reported.message).toContain('decider');
  });

  it('is silent once a question is enabled', () => {
    const input = withConfig(withDecision(), { mode: 'agent', decision: policy() });
    expect(codes(input, 'release')).not.toContain('decision_plugin_unused');
    expect(codes(input, 'release')).not.toContain('decision_plugin_missing');
  });
});

describe('a question the selected model cannot answer', () => {
  const liveCodes = (input: ReturnType<typeof fixture>) => codes(input, 'live');

  it('rejects a primitive the plugin does not declare', () => {
    const input = withConfig(withDecision({ primitives: ['choice'] }), {
      mode: 'agent',
      decision: policy({
        questions: [
          {
            type: 'score',
            id: 'willingness',
            instructions: 'How willing is the caller?',
            threshold: 0.6,
            fallback: 'llm',
            rubric: ['Refuses', 'Willing'],
            bands: [{ atLeast: 0, outcome: { say: 'Noted.' } }],
          },
        ],
      }),
    });
    expect(liveCodes(input)).toContain('decision_primitive_unsupported');
  });

  it('rejects more choice options than the plugin accepts', () => {
    const input = withConfig(withDecision({ maxCriteria: 2 }), {
      mode: 'agent',
      decision: policy({
        questions: [
          {
            ...question,
            options: [
              ...question.options,
              { key: 'third', description: 'A third option', outcome: { say: 'Third.' } },
            ],
          },
        ],
      }),
    });
    const reported = validateSelections(input, 'live').find(
      (entry) => entry.code === 'decision_primitive_unsupported',
    )!;
    expect(reported.message).toContain('3 options');
    expect(reported.field).toBe('intent');
  });

  it('rejects more questions in one request than the plugin accepts', () => {
    const input = withConfig(withDecision({ maxQuestionsPerRequest: 1 }), {
      mode: 'agent',
      decision: policy({
        questions: [question, { ...question, id: 'second' }],
      }),
    });
    const reported = validateSelections(input, 'live').find(
      (entry) => entry.code === 'decision_primitive_unsupported',
    )!;
    expect(reported.message).toContain('per request');
    expect(reported.field).toBe('questions');
  });

  it('accepts a policy inside every declared limit', () => {
    const input = withConfig(withDecision(), { mode: 'agent', decision: policy() });
    expect(liveCodes(input)).not.toContain('decision_primitive_unsupported');
  });

  it('does not run at all when the policy is disabled', () => {
    const input = withConfig(withDecision({ primitives: [] }), {
      mode: 'agent',
      decision: policy({ enabled: false }),
    });
    expect(liveCodes(input)).not.toContain('decision_primitive_unsupported');
  });
});

describe('metering a decision', () => {
  it('requires a price card for the decision meter like any other metered slot', () => {
    const input = withConfig(withDecision(), { mode: 'agent', decision: policy() });
    input.priceCards = { ...input.priceCards };
    delete (input.priceCards as Record<string, unknown>)['decision.usage'];
    expect(codes(input, 'live')).toContain('meter_uncovered');
  });
});
