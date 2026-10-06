import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  AgentDecisionPolicy,
  AgentFlow,
  FLOW_COMPAT_CODES,
  FLOW_MAX_PHRASES,
  FlowCompileError,
  compileFlow,
  flowReachesLlm,
  flowSpeaksFirst,
  inspectFlow,
  type FlowIssue,
} from '../src/index.ts';
import { collectionsFlow } from './flow-fixture.ts';

const parse = (over: Record<string, unknown> = {}) =>
  AgentFlow.parse({ ...collectionsFlow(), ...over });
const errors = (issues: FlowIssue[]) =>
  issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message);

describe('the flow contract (AGT-1)', () => {
  it('rides inside the decision policy, defaulting everything a flow agent need not author', () => {
    const config = AgentConfig.parse({
      name: 'Collections',
      mode: 'agent',
      decision: { enabled: true, flow: collectionsFlow() },
    });
    expect(config.decision?.questions).toEqual([]);
    expect(config.decision?.state).toEqual({ sources: ['last-turn'], transcriptTurns: 6 });
    expect(config.decision?.flow).toMatchObject({
      version: 1,
      threshold: 0.55,
      fallback: 'llm',
      start: 'greet',
    });
  });

  it('loads a published flat-policy config exactly as it did before flows existed', () => {
    const published = {
      enabled: true,
      questions: [
        {
          type: 'choice',
          id: 'intent',
          instructions: 'What does the caller want?',
          threshold: 0.8,
          fallback: 'llm',
          options: [
            { key: 'pay', description: 'Pay now', outcome: { say: 'Sending a link.' } },
            { key: 'other', description: 'Anything else', outcome: {} },
          ],
        },
      ],
      state: { sources: ['last-turn'], transcriptTurns: 4 },
      timeoutMs: 1500,
    };
    expect(AgentDecisionPolicy.parse(published)).toEqual({
      ...published,
      questions: [{ ...published.questions[0], purpose: '' }],
    });
  });

  it('refuses a policy that would answer one turn twice', () => {
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
    expect(() =>
      AgentDecisionPolicy.parse({ enabled: true, questions: [question], flow: collectionsFlow() }),
    ).toThrow(/replaces the decision questions/);
  });

  it('holds an imported POC rule of up to FLOW_MAX_PHRASES phrases per intent', () => {
    const withPhrases = (count: number) => {
      const flow = collectionsFlow();
      flow.listens[0]!.intents[0]!.phrases = Array.from({ length: count }, (_, i) => `yes ${i}`);
      return AgentFlow.safeParse(flow).success;
    };
    expect(FLOW_MAX_PHRASES).toBe(500);
    expect(withPhrases(FLOW_MAX_PHRASES)).toBe(true);
    expect(withPhrases(FLOW_MAX_PHRASES + 1)).toBe(false);
  });

  it('keeps graph rules out of the schema so a half-wired draft still saves', () => {
    expect(() => parse({ start: 'nowhere' })).not.toThrow();
    expect(errors(inspectFlow(parse({ start: 'nowhere' })))).toContain(
      'Start node nowhere does not exist',
    );
  });

  it('reports nothing for the sample collections flow', () => {
    expect(inspectFlow(parse())).toEqual([]);
    expect(FLOW_COMPAT_CODES).toEqual(['flow_invalid', 'decision_mode_unsupported']);
  });
});

describe('flow validation', () => {
  const edit = (change: (flow: ReturnType<typeof collectionsFlow>) => void) => {
    const flow = collectionsFlow();
    change(flow);
    return errors(inspectFlow(AgentFlow.parse(flow)));
  };

  it('reports a missing target, a missing listen set and a missing line', () => {
    expect(
      edit((flow) => {
        flow.listens[0]!.intents[1]!.next = 'nobody';
        flow.nodes[1]!.listen = 'ghost';
        flow.nodes[0]!.say.push('nope');
      }),
    ).toEqual(
      expect.arrayContaining([
        'Node nobody does not exist',
        'Listen set ghost does not exist',
        'Line nope does not exist',
      ]),
    );
  });

  it('refuses a context and question too long to ask the decision model together', () => {
    const issues = (question: number) => {
      const flow = collectionsFlow();
      flow.context = 'c'.repeat(1_500);
      flow.listens[0]!.question = 'q'.repeat(question);
      return inspectFlow(AgentFlow.parse(flow)).filter((issue) => issue.severity === 'error');
    };
    expect(issues(498)).toEqual([]);
    expect(issues(600)).toEqual([
      {
        severity: 'error',
        path: 'listens.0.question',
        message:
          'The context and this question together are 2102 characters; the decision model reads at most 2000',
      },
    ]);
  });

  it('reports a node nothing can reach', () => {
    expect(
      edit((flow) => {
        flow.nodes.push({ id: 'orphan', say: ['goodbye'], end: true });
      }),
    ).toEqual(['Node orphan cannot be reached from greet']);
  });

  it('reports duplicate intents, within a listen set and against the globals', () => {
    expect(
      edit((flow) => {
        flow.listens[0]!.intents.push({ ...flow.listens[0]!.intents[0]!, phrases: [] });
        flow.listens[2]!.intents.push({
          key: 'stop_calling',
          description: 'Also stop',
          next: 'goodbye',
        } as never);
      }),
    ).toEqual(
      expect.arrayContaining([
        'Duplicate intent confirmed',
        'Intent stop_calling is also a global intent; the model could not tell them apart',
      ]),
    );
  });

  it('reserves the automatic other bucket and the intent question id', () => {
    expect(
      edit((flow) => {
        flow.listens[2]!.intents[0]!.key = 'other';
        flow.listens[1]!.slots![0]!.id = 'intent';
      }),
    ).toEqual(
      expect.arrayContaining([
        'Intent other is added automatically and is reserved',
        'Slot id intent is reserved',
      ]),
    );
  });

  it('needs exactly one of next and repeat on every intent', () => {
    expect(
      edit((flow) => {
        flow.globalIntents[0] = { ...flow.globalIntents[0]!, next: 'goodbye' } as never;
        delete (flow.globalIntents[1] as { next?: string }).next;
      }),
    ).toEqual([
      'An intent needs exactly one of `next` or `repeat`',
      'An intent needs exactly one of `next` or `repeat`',
      // Its only route was the global intent that just lost its `next`.
      'Node stop_calling cannot be reached from greet',
    ]);
  });

  it('checks slot routes against the listen set that asks the slot', () => {
    expect(
      edit((flow) => {
        const route = flow.listens[1]!.intents[0]!.next as { cases: Record<string, string> };
        route.cases.someday = 'ptp_ask';
        flow.globalIntents[1]!.next = {
          slot: 'ptp_when',
          cases: {},
          otherwise: 'stop_calling',
        } as never;
      }),
    ).toEqual(
      expect.arrayContaining([
        'Slot ptp_when has no option someday',
        'Slot ptp_when is not asked in this listen set',
      ]),
    );
  });

  it('refuses a whole reply that would mean two intents', () => {
    expect(
      edit((flow) => {
        flow.globalIntents[0]!.phrases = ['Yes!'];
      }),
    ).toEqual(['Phrase "Yes!" means both confirmed and repeat']);
  });

  it('requires a listen set exactly on the nodes that do not end the call', () => {
    expect(
      edit((flow) => {
        delete (flow.nodes[1] as { listen?: string }).listen;
        (flow.nodes[7] as { listen?: string }).listen = 'wrapup';
      }),
    ).toEqual([
      'A node that does not end the call needs a listen set',
      'A node that ends the call does not listen',
    ]);
  });

  it('warns, without blocking, about lines and listen sets nothing uses', () => {
    const flow = collectionsFlow();
    (flow.lines as Record<string, string>).unused = 'Never said.';
    flow.listens.push({ ...flow.listens[2]!, id: 'spare' });
    const issues = inspectFlow(AgentFlow.parse(flow));
    expect(issues.filter((issue) => issue.severity === 'warning').map((i) => i.path)).toEqual([
      'listens.3',
      'lines.unused',
    ]);
    expect(errors(issues)).toEqual([]);
  });
});

describe('compiling a flow', () => {
  it('refuses to compile a flow with errors', () => {
    expect(() => compileFlow(parse({ start: 'nowhere' }))).toThrow(FlowCompileError);
  });

  it('lets the LLM resume only before identity is confirmed until it is', () => {
    const compiled = compileFlow(parse());
    expect(compiled.gatesIdentity).toBe(true);
    expect([...compiled.preVerificationListens]).toEqual(['identity']);
    const open = compileFlow(
      parse({ nodes: collectionsFlow().nodes.map((node) => ({ ...node, verified: false })) }),
    );
    expect(open.gatesIdentity).toBe(false);
    expect([...open.preVerificationListens].sort()).toEqual(['identity', 'payment', 'wrapup']);
  });

  it('greets first only when an enabled flow starts on a node with lines', () => {
    expect(flowSpeaksFirst({ enabled: true, flow: parse() })).toBe(true);
    expect(flowSpeaksFirst({ enabled: false, flow: parse() })).toBe(false);
    expect(flowSpeaksFirst({ enabled: true })).toBe(false);
    expect(flowSpeaksFirst(undefined)).toBe(false);
    const silent = collectionsFlow();
    silent.nodes[0]!.say = [];
    expect(flowSpeaksFirst({ enabled: true, flow: AgentFlow.parse(silent) })).toBe(false);
  });

  it('knows whether any path reaches the LLM', () => {
    expect(flowReachesLlm(parse())).toBe(true);
    expect(flowReachesLlm(parse({ fallback: 'clarify' }))).toBe(false);
    const lineless = collectionsFlow();
    lineless.nodes[5]!.say = [];
    expect(flowReachesLlm(AgentFlow.parse({ ...lineless, fallback: 'clarify' }))).toBe(true);
  });
});
