import { describe, expect, it } from 'vitest';
import { RoutingNode, RulesMatcher, RoutingEngine } from '@winsendotai/ovo-contracts';
import {
  createRulesRunner,
  hasInstantRule,
  matches,
  type RouteTurn,
} from '../src/engines/index.ts';
import type { RulesEnv } from '../src/engines/rules.ts';

// 2026-10-15T06:30Z is Thursday 12:00 in Kolkata.
const NOON_THURSDAY = Date.UTC(2026, 9, 15, 6, 30);
const env = (over: Partial<RulesEnv['call']> = {}, now = NOON_THURSDAY): RulesEnv => ({
  call: {
    callId: 'c',
    workspaceId: 'w',
    routingPointId: 'p',
    routingReleaseId: 'r',
    from: '+919812345678',
    variables: { tier: 'gold', overdue: 3, vip: true },
    ...over,
  },
  now: () => now,
});
const matcher = (raw: Record<string, unknown>) => RulesMatcher.parse(raw);
const speech = (text: string): RouteTurn => ({ text });
const keypad = (digits: string): RouteTurn => ({ digits });
const officeHours = {
  timezone: 'Asia/Kolkata',
  weekly: { thu: [{ start: '09:00', end: '18:00' }] },
};

describe('rules matchers', () => {
  it.each<[string, Record<string, unknown>, RouteTurn | undefined, RulesEnv, boolean]>([
    ['dtmf: exact digits', { kind: 'dtmf', digits: '2' }, keypad('2'), env(), true],
    ['dtmf: other digits', { kind: 'dtmf', digits: '2' }, keypad('21'), env(), false],
    ['dtmf: never on speech', { kind: 'dtmf', digits: '2' }, speech('2'), env(), false],
    ['dtmf: multi-digit with star', { kind: 'dtmf', digits: '9*' }, keypad('9*'), env(), true],
    [
      'caller-id: prefix',
      { kind: 'caller-id', prefixes: ['+4420', '+9198'] },
      undefined,
      env(),
      true,
    ],
    [
      'caller-id: other prefix',
      { kind: 'caller-id', prefixes: ['+4420'] },
      undefined,
      env(),
      false,
    ],
    [
      'caller-id: withheld number',
      { kind: 'caller-id', prefixes: ['+91'] },
      undefined,
      env({ from: undefined }),
      false,
    ],
    ['time: inside open hours', { kind: 'time', hours: officeHours }, undefined, env(), true],
    [
      'time: inside, after hours',
      { kind: 'time', hours: officeHours },
      undefined,
      env({}, NOON_THURSDAY + 7 * 3_600_000),
      false,
    ],
    [
      'time: outside, after hours',
      { kind: 'time', hours: officeHours, inside: false },
      undefined,
      env({}, NOON_THURSDAY + 7 * 3_600_000),
      true,
    ],
    [
      'variable: string',
      { kind: 'variable', name: 'tier', equals: ['gold', 'platinum'] },
      undefined,
      env(),
      true,
    ],
    [
      'variable: number as text',
      { kind: 'variable', name: 'overdue', equals: ['3'] },
      undefined,
      env(),
      true,
    ],
    [
      'variable: boolean as text',
      { kind: 'variable', name: 'vip', equals: ['true'] },
      undefined,
      env(),
      true,
    ],
    [
      'variable: absent',
      { kind: 'variable', name: 'segment', equals: ['x'] },
      undefined,
      env(),
      false,
    ],
    [
      'variable: object never matches',
      { kind: 'variable', name: 'tier', equals: ['[object Object]'] },
      undefined,
      env({ variables: { tier: {} } }),
      false,
    ],
    [
      'keywords: whole word',
      { kind: 'keywords', words: ['loan'] },
      speech('I want a loan, please'),
      env(),
      true,
    ],
    [
      'keywords: not inside a word',
      { kind: 'keywords', words: ['loan'] },
      speech('my loans are fine'),
      env(),
      false,
    ],
    [
      'keywords: multi-word phrase in order',
      { kind: 'keywords', words: ['credit card'] },
      speech('Lost my CREDIT card!'),
      env(),
      true,
    ],
    [
      'keywords: reply too long',
      { kind: 'keywords', words: ['loan'], maxWords: 3 },
      speech('I would like a loan today'),
      env(),
      false,
    ],
    [
      'keywords: Hinglish in Latin letters',
      { kind: 'keywords', words: ['chahiye'] },
      speech('Mujhe naya card chahiye'),
      env(),
      true,
    ],
    [
      'keywords: Devanagari',
      { kind: 'keywords', words: ['लोन'] },
      speech('मुझे लोन चाहिए।'),
      env(),
      true,
    ],
    [
      'keywords: never on a keypad turn',
      { kind: 'keywords', words: ['2'] },
      keypad('2'),
      env(),
      false,
    ],
    [
      'phrases: exact after normalising',
      { kind: 'phrases', phrases: ['Yes, please'] },
      speech('yes please!'),
      env(),
      true,
    ],
    [
      'phrases: more words is not the phrase',
      { kind: 'phrases', phrases: ['yes'] },
      speech('yes but later'),
      env(),
      false,
    ],
    ['phrases: Hindi', { kind: 'phrases', phrases: ['हाँ जी'] }, speech('हाँ जी।'), env(), true],
    [
      'script: Devanagari for hi',
      { kind: 'script', languages: ['hi'] },
      speech('मुझे कार्ड चाहिए'),
      env(),
      true,
    ],
    [
      'script: Hinglish is not hi',
      { kind: 'script', languages: ['hi'] },
      speech('mujhe card chahiye'),
      env(),
      false,
    ],
    [
      'script: Hinglish is en',
      { kind: 'script', languages: ['en'] },
      speech('mujhe card chahiye'),
      env(),
      true,
    ],
    [
      'script: Tamil for ta',
      { kind: 'script', languages: ['ta', 'te'] },
      speech('எனக்கு கடன்'),
      env(),
      true,
    ],
  ])('%s', (_name, raw, turn, environment, expected) => {
    expect(matches(matcher(raw), turn, environment)).toBe(expected);
  });
});

const node = (rules: unknown[]) =>
  RoutingNode.parse({
    id: 'intent',
    engines: [{ kind: 'rules', rules }],
    branches: ['sales', 'support', 'vip'].map((key) => ({
      key,
      description: key,
      target: { kind: 'end', line: { en: 'Bye.' } },
    })),
    fallback: [{ kind: 'end', line: { en: 'Bye.' } }],
  });

async function run(rules: unknown[], turn: RouteTurn | undefined, environment = env()) {
  const parsed = node(rules);
  const engine = parsed.engines[0] as Extract<RoutingEngine, { kind: 'rules' }>;
  return createRulesRunner(environment)(engine, {
    node: parsed,
    ...(turn ? { turn } : {}),
    context: { values: {} },
    languages: ['en', 'hi'],
    transcript: [],
    signal: new AbortController().signal,
  });
}

describe('rules engine', () => {
  it('needs every matcher of a rule', async () => {
    const rules = [
      {
        branch: 'vip',
        when: [
          { kind: 'caller-id', prefixes: ['+91'] },
          { kind: 'dtmf', digits: '9' },
        ],
      },
    ];
    await expect(run(rules, keypad('9'))).resolves.toEqual({
      outcome: 'matched',
      branch: 'vip',
      confidence: 1,
    });
    await expect(run(rules, keypad('8'))).resolves.toEqual({ outcome: 'no_match' });
    await expect(run(rules, keypad('9'), env({ from: '+15550100' }))).resolves.toEqual({
      outcome: 'no_match',
    });
  });

  it('takes the first rule that matches', async () => {
    const rules = [
      { branch: 'support', when: [{ kind: 'keywords', words: ['card'] }] },
      { branch: 'sales', when: [{ kind: 'keywords', words: ['new'] }] },
    ];
    await expect(run(rules, speech('a new card'))).resolves.toMatchObject({ branch: 'support' });
    await expect(run(rules, speech('something new'))).resolves.toMatchObject({ branch: 'sales' });
  });

  it('skips a rule naming a branch the node lacks', async () => {
    const rules = [
      { branch: 'billing', when: [{ kind: 'dtmf', digits: '1' }] },
      { branch: 'sales', when: [{ kind: 'dtmf', digits: '1' }] },
    ];
    await expect(run(rules, keypad('1'))).resolves.toMatchObject({ branch: 'sales' });
  });

  it('is an error when hours cannot be read', async () => {
    const rules = [{ branch: 'sales', when: [{ kind: 'time', hours: officeHours }] }];
    const broken = env({}, Number.NaN);
    await expect(run(rules, undefined, broken)).resolves.toEqual({
      outcome: 'error',
      reason: 'rules_failed',
    });
  });

  it('knows which rules can decide before the caller speaks', () => {
    const instant = node([{ branch: 'vip', when: [{ kind: 'caller-id', prefixes: ['+91'] }] }]);
    const spoken = node([
      {
        branch: 'sales',
        when: [
          { kind: 'dtmf', digits: '1' },
          { kind: 'caller-id', prefixes: ['+91'] },
        ],
      },
    ]);
    expect(hasInstantRule(instant.engines[0] as never)).toBe(true);
    expect(hasInstantRule(spoken.engines[0] as never)).toBe(false);
  });
});
