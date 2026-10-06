import { describe, expect, it } from 'vitest';
import { Cap, type ReleaseSelections } from '@winsendotai/ovo-contracts';
import { definePlugin, PluginRegistry } from '@winsendotai/ovo-runtime';
import { validateSelections } from '../src/compat/index.ts';
import { codes, fixture, withConfig } from './compat-support.ts';
import { collectionsFlow } from './flow-fixture.ts';

const variables = {
  type: 'object',
  properties: { full_name: { type: 'string' }, emi: { type: 'string' } },
  additionalProperties: false,
};

const flowAgent = (flow: Record<string, unknown> = collectionsFlow(), over = {}) =>
  withConfig(withDecision(), {
    mode: 'agent',
    variables,
    decision: { enabled: true, flow },
    ...over,
  });

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
      capabilities: {
        primitives: ['choice'],
        maxCriteria: 8,
        maxQuestionsPerRequest: 4,
        languages: ['en-IN'],
        calibration: { label: 'cohort-a', source: 'vendor-published' },
        ...capabilities,
      },
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

const found = (
  input: ReturnType<typeof fixture>,
  code: string,
  stage: 'release' | 'live' | 'test',
) => validateSelections(input, stage).filter((entry) => entry.code === code);

describe('a flow at release (AGT-1)', () => {
  it('releases a sound flow with no flow issue at all', () => {
    const input = flowAgent();
    for (const code of [
      'flow_invalid',
      'template_variable_undeclared',
      'decision_mode_unsupported',
      'decision_primitive_unsupported',
      'decision_plugin_missing',
      'decision_plugin_unused',
    ])
      expect(codes(input, 'live')).not.toContain(code);
  });

  it('blocks a missing target and an unreachable node, by field', () => {
    const flow = collectionsFlow();
    flow.listens[0]!.intents[1]!.next = 'nobody';
    const issues = found(flowAgent(flow), 'flow_invalid', 'release');
    expect(issues.map((entry) => [entry.severity, entry.field])).toEqual([
      ['error', 'decision.flow.listens.0.intents.1.next'],
      ['error', 'decision.flow.nodes.6'],
    ]);
    expect(issues[0]!.message).toBe(
      'decision.flow.listens.0.intents.1.next: Node nobody does not exist',
    );
  });

  it('blocks duplicate intents', () => {
    const flow = collectionsFlow();
    flow.listens[2]!.intents.push({ ...flow.listens[2]!.intents[0]!, phrases: [] });
    expect(found(flowAgent(flow), 'flow_invalid', 'release')[0]).toMatchObject({
      severity: 'error',
      message: expect.stringContaining('Duplicate intent no_more'),
    });
  });

  it('only warns about a line nothing speaks', () => {
    const flow = collectionsFlow();
    (flow.lines as Record<string, string>).spare = 'Never said.';
    expect(found(flowAgent(flow), 'flow_invalid', 'release')).toEqual([
      expect.objectContaining({ severity: 'warning', field: 'decision.flow.lines.spare' }),
    ]);
  });

  it('blocks a line that reads an undeclared variable', () => {
    const flow = collectionsFlow();
    flow.lines.emi = 'Your EMI of {{amount_due}} is pending.';
    expect(found(flowAgent(flow), 'template_variable_undeclared', 'release')).toEqual([
      expect.objectContaining({ severity: 'error', field: 'decision.flow.lines.emi' }),
    ]);
  });

  it('reserves the resume tool id', () => {
    const input = flowAgent(collectionsFlow(), {
      tools: [
        {
          id: 'resume_flow',
          description: 'mine',
          connector: 'native',
          inputSchema: {},
          effect: 'read',
        },
      ],
    });
    expect(found(input, 'flow_invalid', 'release')[0]!.field).toBe('tools');
  });

  it('still needs a decision plugin, like any enabled policy', () => {
    const input = flowAgent();
    input.selections = { ...input.selections, decision: undefined };
    expect(codes(input, 'release')).toContain('decision_plugin_missing');
  });
});

describe('a flow the selected decision model cannot answer', () => {
  it('blocks a listen set wider than the model accepts', () => {
    const input = flowAgent();
    input.registry = withDecision({ maxCriteria: 4 }).registry;
    const issues = found(input, 'decision_primitive_unsupported', 'live');
    // identity: three intents, two globals and other.
    expect(issues.map((entry) => entry.field)).toEqual(['decision.flow.listens.0']);
    expect(issues[0]!.message).toContain('6 options');
    expect(codes(input, 'release')).not.toContain('decision_primitive_unsupported');
  });

  it('blocks a listen set that asks more questions at once than the model takes', () => {
    const input = flowAgent();
    input.registry = withDecision({ maxQuestionsPerRequest: 1 }).registry;
    expect(found(input, 'decision_primitive_unsupported', 'live')[0]!.field).toBe(
      'decision.flow.listens.1',
    );
  });

  it('blocks a model that answers no choice questions', () => {
    const input = flowAgent();
    input.registry = withDecision({ primitives: ['noul'] }).registry;
    expect(found(input, 'decision_primitive_unsupported', 'live')).toHaveLength(1);
  });
});

describe('decisions in each mode (AGT-14)', () => {
  const script = {
    start: 'ask',
    nodes: [
      {
        id: 'ask',
        prompt: 'Pay now?',
        transitions: [
          { event: 'text', matches: ['yes'], to: 'done' },
          { event: 'text', matches: ['no'], to: 'done' },
        ],
      },
      { id: 'done', prompt: 'Thanks.', terminal: true },
    ],
  };
  const question = {
    type: 'choice',
    id: 'intent',
    instructions: 'What?',
    threshold: 0.8,
    fallback: 'llm',
    options: [
      { key: 'a', description: 'A', outcome: {} },
      { key: 'b', description: 'B', outcome: {} },
    ],
  };
  const mode = (config: Record<string, unknown>) =>
    found(withConfig(withDecision(), config), 'decision_mode_unsupported', 'release');

  it('lets a script use the decision model to match its transitions', () => {
    expect(mode({ mode: 'announcement', script, decision: { enabled: true } })).toEqual([]);
  });

  it('refuses decision questions or a flow that a mode would silently ignore', () => {
    expect(mode({ mode: 'faq', decision: { enabled: true, questions: [question] } })).toEqual([
      expect.objectContaining({ field: 'decision', severity: 'error' }),
    ]);
    expect(
      mode({ mode: 'announcement', script, decision: { enabled: true, questions: [question] } }),
    ).toEqual([expect.objectContaining({ field: 'decision.questions' })]);
    expect(
      mode({ mode: 'faq', script, decision: { enabled: true, flow: collectionsFlow() } }),
    ).toEqual([expect.objectContaining({ field: 'decision.flow' })]);
    expect(mode({ mode: 'context', decision: { enabled: true } })).toHaveLength(1);
  });

  it('still admits a release published before flows with questions outside agent mode', () => {
    const before = [
      { mode: 'faq', decision: { enabled: true, questions: [question] } },
      { mode: 'announcement', script, decision: { enabled: true, questions: [question] } },
    ];
    for (const config of before) {
      // Two options fit the questions; a script's two transitions plus `other` would not.
      const input = withConfig(withDecision({ maxCriteria: 2 }), config);
      for (const stage of ['live', 'test'] as const) {
        const errors = validateSelections(input, stage).filter(
          (entry) => entry.severity === 'error',
        );
        expect(errors, `${config.mode} at ${stage}`).toEqual([]);
        expect(found(input, 'decision_mode_unsupported', stage)).toEqual([
          expect.objectContaining({ severity: 'warning' }),
        ]);
      }
    }
  });

  it('blocks at every stage what no earlier release could carry', () => {
    const input = withConfig(withDecision(), {
      mode: 'faq',
      script,
      decision: { enabled: true, flow: collectionsFlow() },
    });
    expect(found(input, 'decision_mode_unsupported', 'live')).toEqual([
      expect.objectContaining({ severity: 'error', field: 'decision.flow' }),
    ]);
  });

  it('refuses an agent policy that has neither questions nor a flow', () => {
    expect(mode({ mode: 'agent', decision: { enabled: true } })).toHaveLength(1);
  });

  it('says nothing about a disabled policy', () => {
    expect(mode({ mode: 'faq', decision: { enabled: false, questions: [question] } })).toEqual([]);
  });

  it("checks a script's transitions against the model's limits", () => {
    const input = withConfig(withDecision({ maxCriteria: 1 }), {
      mode: 'announcement',
      script,
      decision: { enabled: true },
    });
    expect(found(input, 'decision_primitive_unsupported', 'live')[0]!.field).toBe('script.nodes.0');
  });
});
