import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  agentLlmPaths,
  agentRecoveryLines,
  DEFAULT_DIDNT_CATCH,
  DEFAULT_GIVE_UP,
  AgentRules,
  RULE_PATTERN_MAX_COST,
  rulePatternCost,
  unsafeRulePattern,
} from '../src/index.ts';

const say = (text: string) => ({ say: text });
/** A decision policy whose every outcome speaks and whose fallback is clarification. */
const scripted = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  questions: [
    {
      type: 'choice',
      id: 'intent',
      instructions: 'What does the caller want?',
      threshold: 0.7,
      fallback: 'clarify',
      options: [
        { key: 'pay', description: 'Will pay', outcome: say('Thank you.') },
        { key: 'bye', description: 'Wants to go', outcome: { say: 'Goodbye.', end: true } },
      ],
      ...over,
    },
  ],
  state: { sources: ['last-turn'] },
});
const agent = (over: Record<string, unknown> = {}) =>
  AgentConfig.parse({ name: 'Collections', mode: 'agent', ...over });
const issues = (over: Record<string, unknown>) =>
  AgentConfig.safeParse({ name: 'Collections', mode: 'agent', ...over }).error?.issues.map(
    (issue) => issue.message,
  );

describe('Jev-only reachability (AGT-4)', () => {
  it('needs the LLM for an agent without a decision policy, and never for announcement or faq', () => {
    expect(agentLlmPaths(agent())).toEqual(['decision']);
    expect(agentLlmPaths(AgentConfig.parse({ name: 'A', mode: 'faq' }))).toEqual([]);
    expect(agentLlmPaths(AgentConfig.parse({ name: 'A', mode: 'context' }))).toEqual(['mode']);
  });

  it('is Jev-only once every outcome speaks and an unavailable decision has a line', () => {
    expect(agentLlmPaths(agent({ decision: scripted() }))).toEqual(['decisionUnavailable']);
    expect(
      agentLlmPaths(agent({ decision: scripted(), decisionUnavailable: { line: 'One moment.' } })),
    ).toEqual([]);
    // A recovery block answers an unavailable decision with its re-ask line.
    expect(agentLlmPaths(agent({ decision: scripted(), recovery: {} }))).toEqual([]);
  });

  it('names every path that still reaches the LLM', () => {
    const config = agent({
      decision: scripted({
        fallback: 'llm',
        options: [
          { key: 'pay', description: 'Will pay', outcome: {} },
          { key: 'bye', description: 'Wants to go', outcome: say('Goodbye.') },
        ],
      }),
      recovery: { exhausted: { action: 'llm' } },
      tools: [
        {
          id: 'lookup',
          description: 'Look up',
          connector: 'native',
          inputSchema: {},
          effect: 'read',
        },
      ],
      allowedTools: ['lookup'],
    });
    expect(agentLlmPaths(config)).toEqual([
      'decision.questions.0.fallback',
      'decision.questions.0.options.0.outcome.say',
      'recovery.exhausted.action',
      'allowedTools',
    ]);
  });
});

describe('agent recovery, idle and rules config', () => {
  it('leaves a config without the new blocks exactly as it parsed before', () => {
    const parsed = agent({ decision: scripted() });
    for (const field of ['rules', 'idle', 'recovery', 'decisionUnavailable'])
      expect(parsed).not.toHaveProperty(field);
  });

  it('fills the recovery defaults from the POC lines', () => {
    expect(agent({ recovery: {} }).recovery).toEqual({
      didntCatch: DEFAULT_DIDNT_CATCH,
      reprompts: {},
      maxAttempts: 2,
      exhausted: { action: 'end', line: DEFAULT_GIVE_UP },
    });
    expect(agent({ recovery: { repeat: {} } }).recovery?.repeat).toEqual({
      prefix: 'Sure, let me repeat that.',
      phrases: [],
    });
  });

  it('rejects an idle policy that would say nothing, and the blocks outside agent mode', () => {
    expect(issues({ idle: { timeoutMs: 5000 } })).toEqual([
      'An idle policy needs at least one prompt or a final line',
    ]);
    const faq = AgentConfig.safeParse({
      name: 'A',
      mode: 'faq',
      idle: { prompts: ['Hello?'] },
      recovery: {},
    });
    expect(faq.error?.issues.map((issue) => issue.path)).toEqual([['idle'], ['recovery']]);
  });

  it('needs a line for an unavailable decision that ends the call', () => {
    expect(issues({ decision: scripted(), decisionUnavailable: { action: 'end' } })).toEqual([
      'Ending the call when the decision is unavailable needs the line to end on',
    ]);
  });

  it('routes rules and the unavailable line through an enabled decision policy', () => {
    const rule = { intent: 'intent=pay', lexicons: ['yes'] };
    expect(issues({ rules: { global: [rule] } })).toEqual([
      'rules needs an enabled decision policy',
    ]);
    expect(issues({ decisionUnavailable: { line: 'One moment.' } })).toEqual([
      'decisionUnavailable needs an enabled decision policy',
    ]);
    expect(agent({ decision: scripted(), rules: { global: [rule] } }).rules?.global[0]).toEqual({
      intent: 'intent=pay',
      phrases: [],
      keywords: [],
      patterns: [],
      lexicons: ['yes'],
      maxWords: 4,
    });
  });

  it('rejects a rule target or re-ask the decision policy does not offer', () => {
    const decision = scripted();
    expect(
      issues({
        decision,
        rules: {
          global: [
            { intent: 'intent=refund', phrases: ['refund'] },
            { intent: 'mood=yes', phrases: ['yes'] },
            { intent: 'pay', phrases: ['pay'] },
          ],
        },
        recovery: { reprompts: { mood: 'How are you?' } },
      }),
    ).toEqual([
      'Re-ask mood names no decision question',
      'Rule intent=refund names no answer of intent',
      'Rule mood=yes names no decision question',
      'Rule pay must name <question>=<answer> without a flow',
    ]);
    expect(issues({ decision, rules: { listens: { identity: [] } } })).toEqual([
      'Listen-set rules need a flow; use global rules for a decision policy',
    ]);
    expect(issues({ decision, rules: { global: [{ intent: 'intent=pay' }] } })).toEqual([
      'A rule needs at least one phrase, keyword, pattern or lexicon',
    ]);
  });
});

describe('rule patterns that cannot backtrack catastrophically (AGT-6)', () => {
  it.each([
    'not yet|not received',
    '(yes|yeah)( please)?',
    'pay (it )?(today|tomorrow)',
    '.*\\bbye\\b.*',
    'call (me )?after [0-9]{1,2}',
    '[(+*]+ok',
    '(yes|no)?( sir)?',
    '\\p{L}{2}\\u{41}',
    '.{0,20}.{0,20}.{0,20}.{0,20}x',
  ])('accepts %s', (pattern) => expect(unsafeRulePattern(pattern)).toBeUndefined());

  it.each([
    ['(a+)+', 'repeats a group that itself repeats or alternates'],
    ['(yes|yeah)*', 'repeats a group that itself repeats or alternates'],
    ['((ab)*c)+', 'repeats a group that itself repeats or alternates'],
    ['(a{2,})+', 'repeats a group that itself repeats or alternates'],
    ['(\\w)\\1', 'uses a backreference'],
    ['(?<=yes)no', 'uses a lookbehind'],
    ['(a?)+', 'repeats a group that itself repeats or alternates'],
    ['(yes|no){2}', 'repeats a group that itself repeats or alternates'],
    ['a*b*c*d*', 'has too many repeats, optional parts or alternatives'],
    // Bounded repeats, optional parts and alternatives multiply paths just as `*` does.
    ['.{0,20}'.repeat(7) + 'x', 'has too many repeats, optional parts or alternatives'],
    ['.?'.repeat(20) + 'x', 'has too many repeats, optional parts or alternatives'],
    ['(?:.|a)'.repeat(20) + 'x', 'has too many repeats, optional parts or alternatives'],
    ['(', 'is not a valid regular expression'],
  ])('refuses %s', (pattern, reason) => expect(unsafeRulePattern(pattern)).toBe(reason));

  it('bounds the match paths: sequences multiply, alternatives add, `?` doubles', () => {
    expect(rulePatternCost('not yet|not received')).toBe(2);
    expect(rulePatternCost('pay (it )?(today|tomorrow)')).toBe(4);
    expect(rulePatternCost('.*\\bbye\\b.*')).toBe(121 ** 2);
    expect(rulePatternCost('[0-9]{1,2}a{3}')).toBe(2);
    expect(rulePatternCost('.*.*' + '.?'.repeat(4))).toBe(RULE_PATTERN_MAX_COST);
  });

  it('refuses rules whose patterns are too costly to try together on one turn', () => {
    const costly = { intent: 'intent=pay', patterns: ['.*.*' + '.?'.repeat(4)] };
    expect(AgentRules.safeParse({ global: Array(4).fill(costly) }).success).toBe(true);
    const tooMany = AgentRules.safeParse({ global: Array(5).fill(costly) });
    expect(tooMany.error?.issues.map((issue) => issue.message)).toEqual([
      'Rule patterns tried on one turn are too costly together; simplify or remove some',
    ]);
    const split = AgentRules.safeParse({
      global: Array(3).fill(costly),
      listens: { identity: Array(1).fill(costly), payment: Array(2).fill(costly) },
    });
    expect(split.error?.issues.map((issue) => issue.path)).toEqual([['listens', 'payment']]);
  });

  it('reports an unsafe pattern as a config error', () => {
    expect(
      issues({
        decision: scripted(),
        rules: { global: [{ intent: 'intent=pay', patterns: ['(a+)+$'] }] },
      }),
    ).toEqual(['Rule pattern repeats a group that itself repeats or alternates']);
  });
});

describe('recovery and idle lines for templates and the clip cache', () => {
  it('lists every line that can be spoken, with its field', () => {
    const config = agent({
      decision: scripted(),
      idle: { prompts: ['Hello?', 'Are you there, {{name}}?'], finalLine: 'Goodbye.' },
      recovery: {
        reprompts: { intent: 'When can you pay?' },
        repeat: {},
        exhausted: { action: 'llm' },
      },
      decisionUnavailable: { line: 'One moment please.' },
      variables: { type: 'object', properties: { name: { type: 'string' } } },
    });
    expect(agentRecoveryLines(config)).toEqual([
      { field: 'idle.prompts.0', text: 'Hello?' },
      { field: 'idle.prompts.1', text: 'Are you there, {{name}}?' },
      { field: 'idle.finalLine', text: 'Goodbye.' },
      { field: 'recovery.didntCatch', text: DEFAULT_DIDNT_CATCH },
      { field: 'recovery.reprompts.intent', text: 'When can you pay?' },
      { field: 'recovery.repeat.prefix', text: 'Sure, let me repeat that.' },
      { field: 'decisionUnavailable.line', text: 'One moment please.' },
    ]);
  });

  it('includes the built-in lines a Jev-only agent without a recovery block can speak', () => {
    const config = agent({ decision: scripted(), decisionUnavailable: {} });
    expect(agentRecoveryLines(config)).toEqual([
      { field: 'recovery.didntCatch', text: DEFAULT_DIDNT_CATCH },
      { field: 'recovery.exhausted.line', text: DEFAULT_GIVE_UP },
    ]);
    expect(agentRecoveryLines(agent())).toEqual([]);
  });
});
