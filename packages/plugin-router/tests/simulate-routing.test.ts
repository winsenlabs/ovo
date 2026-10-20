import { describe, expect, it, vi } from 'vitest';
import { exampleRoutingSnapshot, EXAMPLE_IDS as I } from '../src/testing.ts';
import { dtmf, NIGHT, nodeSteps, simulate, speech, trace } from './support-sim.ts';
import { OFFICE } from './support-human.ts';

const llm = (over: Record<string, unknown> = {}) => ({
  node: 'intent',
  engine: 'llm' as const,
  ...over,
});
const withRules = (rules: unknown[]) =>
  exampleRoutingSnapshot((raw) => {
    raw.nodes[0].engines = [{ kind: 'rules', rules }];
  });
const rule = (matcher: Record<string, unknown>) => [{ branch: 'sales', when: [matcher] }];

describe('simulateRoute: determinism', () => {
  const body = {
    call: { from: '+912212345678', at: '2026-10-15T06:30:00Z' },
    turns: [speech('mujhe naya card chahiye')],
    engines: {
      answers: [llm({ branch: 'sales', confidence: 0.91, language: 'hi' })],
    },
  };

  it('gives a byte-identical result for the same request and clock, whatever time it is', async () => {
    const snapshot = exampleRoutingSnapshot();
    const first = JSON.stringify(await simulate(snapshot, body));
    vi.useFakeTimers({ now: Date.UTC(2031, 0, 1) });
    try {
      expect(JSON.stringify(await simulate(snapshot, body))).toBe(first);
    } finally {
      vi.useRealTimers();
    }
    expect(JSON.parse(first).at).toBe('2026-10-15T06:30:00.000Z');
  });

  it('echoes the clock it used and warns that it was overridden', async () => {
    const run = await simulate(exampleRoutingSnapshot(), body);
    expect(run.at).toBe('2026-10-15T06:30:00.000Z');
    expect(run.warnings.map((w) => w.code)).toEqual(['clock_overridden']);
  });
});

describe('simulateRoute: the opening and the keypad', () => {
  it('says the greeting first and routes keypad 1 to the sales pool', async () => {
    const run = await simulate(exampleRoutingSnapshot(), { turns: [dtmf('1')] });
    expect(run.turns.map((t) => [t.index, t.input.kind, t.phase])).toEqual([
      [0, 'opening', 'routing'],
      [1, 'dtmf', 'announcing'],
    ]);
    expect(run.turns[0]!.say).toBe('Welcome to Acme. How can I help you today?');
    expect(run.turns[1]!.say).toBe('Connecting you now.');
    expect(run.outcome).toMatchObject({
      status: 'agent',
      completionReason: 'route:agent:intent',
      path: ['intent'],
      node: 'intent',
      agent: {
        agentId: 'sales-en',
        releaseId: I.salesEn,
        poolId: I.salesPool,
        memberId: 'sales-en',
      },
      turns: 1,
      line: 'Connecting you now.',
      degraded: null,
    });
    expect(run.outcome.targetVariables).toEqual({ ovo_route_intent: 'sales' });
  });

  it('measures time on the virtual clock: three seconds a caller turn', async () => {
    const run = await simulate(exampleRoutingSnapshot(), { turns: [speech('umm'), dtmf('1')] });
    expect(run.turns.map((t) => t.virtualMs)).toEqual([0, 3000, 6000]);
    expect(run.outcome.routeMs).toBe(6000);
    expect(run.stats).toEqual({ ms: 0, virtualMs: 6000, routerTurns: 2, liveCalls: 0 });
  });

  it('marks scripted verdicts as mocked and the rules engine as real', async () => {
    const run = await simulate(exampleRoutingSnapshot(), {
      turns: [speech('card please')],
      engines: { answers: [llm({ branch: 'sales', confidence: 0.9 })] },
    });
    expect(nodeSteps(run).map((s) => [s.engine, s.mocked])).toEqual([
      ['rules', false],
      ['llm', true],
    ]);
    expect(run.engineModes).toEqual({
      rules: 'real',
      decision: 'mock',
      llm: 'mock',
      external: 'mock',
    });
  });
});

describe('simulateRoute: the rules engine runs for real', () => {
  const cases: [string, Record<string, unknown>, Parameters<typeof simulate>[1], number][] = [
    ['keypad digits', { kind: 'dtmf', digits: '5' }, { turns: [dtmf('5')] }, 1],
    [
      'a caller-id prefix',
      { kind: 'caller-id', prefixes: ['+9122'] },
      { call: { from: '+912212345678' } },
      0,
    ],
    [
      'a variable',
      { kind: 'variable', name: 'vip', equals: ['yes'] },
      { call: { variables: { vip: 'yes' } } },
      0,
    ],
    ['office hours at the call clock', { kind: 'time', hours: OFFICE, inside: true }, {}, 0],
    [
      'whole-word keywords',
      { kind: 'keywords', words: ['card'], maxWords: 4 },
      { turns: [speech('my card')] },
      1,
    ],
    [
      'an exact phrase',
      { kind: 'phrases', phrases: ['new account'] },
      { turns: [speech('New account!')] },
      1,
    ],
    [
      'the reply script',
      { kind: 'script', languages: ['hi'] },
      { turns: [speech('मुझे कार्ड चाहिए')] },
      1,
    ],
  ];

  it.each(cases)('%s', async (_name, matcher, body, decidedAt) => {
    const run = await simulate(withRules(rule(matcher)), body);
    expect(run.outcome.status).toBe('agent');
    expect(run.turns.findIndex((t) => t.phase === 'announcing')).toBe(decidedAt);
    expect(trace(run)).toContain('node:intent:rules:matched>sales');
    expect(run.warnings).toEqual([]);
  });

  it.each([
    [
      'a caller-id prefix that does not match',
      { kind: 'caller-id', prefixes: ['+9122'] },
      { call: { from: '+14155550100' } },
    ],
    ['a caller with no id', { kind: 'caller-id', prefixes: ['+9122'] }, {}],
    [
      'a variable with another value',
      { kind: 'variable', name: 'vip', equals: ['yes'] },
      { call: { variables: { vip: 'no' } } },
    ],
    [
      'office hours when the call clock says night',
      { kind: 'time', hours: OFFICE, inside: true },
      { call: { at: new Date(NIGHT).toISOString() } },
    ],
    [
      'keywords in a reply that is too long',
      { kind: 'keywords', words: ['card'], maxWords: 2 },
      { turns: [speech('my card is blocked')] },
    ],
  ])('does not decide on %s', async (_name, matcher, body) => {
    const run = await simulate(withRules(rule(matcher)), body);
    expect(run.turns[0]!.phase).toBe('routing');
    expect(run.turns[0]!.say).toBe('Welcome to Acme. How can I help you today?');
  });

  it('decides on the opening when a rule needs only the call, before the caller speaks', async () => {
    const run = await simulate(
      withRules(rule({ kind: 'variable', name: 'vip', equals: ['yes'] })),
      {
        call: { variables: { vip: 'yes' } },
        turns: [speech('ignored')],
      },
    );
    expect(run.turns).toHaveLength(1);
    expect(run.turns[0]).toMatchObject({ phase: 'announcing', say: 'Connecting you now.' });
    expect(run.warnings.map((w) => w.code)).toEqual(['turns_unused']);
    expect(run.warnings[0]!.message).toContain('1 caller turn');
  });
});

describe('simulateRoute: scripted engine answers', () => {
  const at = async (confidence: number, over: Record<string, unknown> = {}) => {
    const run = await simulate(exampleRoutingSnapshot(), {
      turns: [speech('card')],
      engines: { answers: [llm({ branch: 'sales', confidence, ...over })] },
    });
    return trace(run).filter((line) => line.includes(':llm:'));
  };

  it('derives matched at the engine threshold and low_confidence just under it', async () => {
    expect(await at(0.6)).toEqual(['node:intent:llm:matched>sales']);
    expect(await at(0.59)).toEqual(['node:intent:llm:low_confidence>sales']);
  });

  it('treats an absent confidence as certain', async () => {
    expect(await at(undefined as never)).toEqual(['node:intent:llm:matched>sales']);
  });

  it('lets an answer name the outcome: a timeout moves on, an error is recorded', async () => {
    expect(await at(0.9, { outcome: 'timeout', branch: undefined })).toEqual([
      'node:intent:llm:timeout',
    ]);
    const run = await simulate(exampleRoutingSnapshot(), {
      turns: [speech('card')],
      engines: { answers: [llm({ outcome: 'error', reason: 'http_503' })] },
    });
    expect(nodeSteps(run).find((s) => s.outcome === 'error')).toMatchObject({
      engine: 'llm',
      reason: 'http_503',
    });
  });

  it('reports a classifier that cannot tell as low confidence and a webhook that names nothing as no match', async () => {
    expect(await at(0.9, { branch: null })).toEqual(['node:intent:llm:low_confidence']);
  });

  it('consumes answers in order per node and engine', async () => {
    const run = await simulate(exampleRoutingSnapshot(), {
      turns: [speech('umm'), speech('a card')],
      engines: {
        answers: [
          llm({ branch: 'sales', confidence: 0.2 }),
          llm({ branch: 'sales', confidence: 0.9 }),
        ],
      },
    });
    expect(trace(run).filter((line) => line.includes(':llm:'))).toEqual([
      'node:intent:llm:low_confidence>sales',
      'node:intent:llm:matched>sales',
    ]);
    expect(run.warnings).toEqual([]);
  });

  it('keeps a repeating answer for every later call', async () => {
    const run = await simulate(exampleRoutingSnapshot(), {
      turns: [speech('a'), speech('b')],
      engines: { answers: [llm({ branch: 'sales', confidence: 0.1, repeat: true })] },
    });
    expect(trace(run).filter((line) => line.includes(':llm:'))).toEqual([
      'node:intent:llm:low_confidence>sales',
      'node:intent:llm:low_confidence>sales',
    ]);
  });

  it('warns once per node and engine when nothing is scripted, and reports no_match', async () => {
    const run = await simulate(exampleRoutingSnapshot(), { turns: [speech('a'), speech('b')] });
    expect(run.warnings).toEqual([
      expect.objectContaining({ code: 'engine_unscripted', node: 'intent', engine: 'llm' }),
    ]);
    expect(nodeSteps(run).filter((s) => s.engine === 'llm')).toEqual([
      expect.objectContaining({ outcome: 'no_match', reason: 'unscripted' }),
      expect.objectContaining({ outcome: 'no_match', reason: 'unscripted' }),
    ]);
  });

  it('applies a detected language and the route context to the target agent', async () => {
    const run = await simulate(exampleRoutingSnapshot(), {
      turns: [speech('mujhe naya credit card chahiye')],
      engines: { answers: [llm({ branch: 'sales', confidence: 0.91, language: 'hi' })] },
    });
    expect(run.outcome).toMatchObject({
      status: 'agent',
      language: 'hi',
      context: { intent: 'sales' },
      agent: { memberId: 'sales-hi' },
      line: 'आपकी कॉल अभी जोड़ी जा रही है।',
    });
    expect(run.outcome.targetVariables).toEqual({
      ovo_route_language: 'hi',
      ovo_route_intent: 'sales',
    });
  });

  it('drops what the engine could not have produced', async () => {
    const run = await simulate(exampleRoutingSnapshot(), {
      turns: [speech('card')],
      engines: {
        answers: [
          llm({ branch: 'sales', confidence: 0.1, clarify: 'Which card?', language: 'hi' }),
        ],
      },
    });
    // generatedClarify is off: the authored re-ask is said, and a low-confidence language is still read.
    expect(run.turns[1]!.say).toBe('Is it about buying something new, or an existing account?');
  });

  it('speaks the generated clarify question when the engine asks for one', async () => {
    const snapshot = exampleRoutingSnapshot((raw) => {
      raw.nodes[0].engines[1].generatedClarify = true;
    });
    const run = await simulate(snapshot, {
      turns: [speech('card')],
      engines: { answers: [llm({ branch: 'sales', confidence: 0.1, clarify: 'Which card?' })] },
    });
    expect(run.turns[1]!.say).toBe('Which card?');
  });
});
