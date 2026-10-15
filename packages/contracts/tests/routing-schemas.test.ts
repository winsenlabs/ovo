import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  DecisionEngine,
  ExternalEngine,
  FallbackStep,
  LlmEngine,
  PinnedAgentRef,
  PoolMember,
  PoolSnapshot,
  RouteAgentRef,
  RouteContextKey,
  RouteLanguage,
  RouteLines,
  RouteReleaseRef,
  RouteVariableName,
  RouteWindow,
  RoutingBranch,
  RoutingEngine,
  RoutingHours,
  RoutingKey,
  RoutingNode,
  RoutingPointDraft,
  RoutingPoolDefinition,
  RoutingTarget,
  RulesEngine,
  RulesMatcher,
  RulesRule,
} from '../src/index.ts';
import { DEFAULT_RELEASE, POOL_SALES, draftInput } from './routing-fixture.ts';

const pinned = { agentId: 'sales-hi', release: { kind: 'pinned', releaseId: DEFAULT_RELEASE } };
const latest = { agentId: 'sales-hi', release: { kind: 'latest' } };
const hours = { timezone: 'Asia/Kolkata', weekly: { mon: [{ start: '09:00', end: '21:00' }] } };
const member = { id: 'sales-hi', agent: latest, languages: ['hi'] };
const node = draftInput().nodes as Record<string, any>[];
const line = { en: 'Goodbye.' };
const external = {
  kind: 'external',
  endpoint: 'https://decide.example.com/route',
  credentialId: 'hmac',
};

/** [name, schema, valid inputs, invalid inputs]: every routing schema, both ways. */
const CASES: [string, z.ZodType, unknown[], unknown[]][] = [
  ['RoutingKey', RoutingKey, ['sales', 'intent_2', 'a-b'], ['Sales', '1st', '', 'a'.repeat(81)]],
  ['RouteContextKey', RouteContextKey, ['product', 'lang_2'], ['has-dash', 'X', 'a'.repeat(41)]],
  ['RouteLanguage', RouteLanguage, ['en', 'hi', 'kok'], ['EN', 'e', 'en-IN', 'engl']],
  ['RouteVariableName', RouteVariableName, ['account', 'Due_Date'], ['_x', '9a', 'a-b']],
  ['RouteLines', RouteLines, [line, { en: 'Hi', hi: 'नमस्ते' }], [{}, { en: ' ' }, { EN: 'x' }]],
  ['RouteReleaseRef', RouteReleaseRef, [latest.release, pinned.release], [{ kind: 'pinned' }]],
  ['RouteAgentRef', RouteAgentRef, [latest, pinned], [{ agentId: '', release: latest.release }]],
  ['PinnedAgentRef', PinnedAgentRef, [pinned], [latest]],
  [
    'RouteWindow',
    RouteWindow,
    [{ start: '09:00', end: '17:30' }],
    [{ start: '22:00', end: '06:00' }],
  ],
  [
    'RoutingHours',
    RoutingHours,
    [hours, { ...hours, weekly: {}, closed: ['2026-12-25'] }],
    [
      { ...hours, timezone: 'Mars/Olympus' },
      { ...hours, weekly: { funday: [] } },
    ],
  ],
  [
    'PoolMember',
    PoolMember,
    [member, { ...member, hours, capacity: 20, priority: 90, products: ['cards'] }],
    [
      { ...member, languages: [] },
      { ...member, priority: 101 },
      { ...member, capacity: 0 },
    ],
  ],
  [
    'RoutingPoolDefinition',
    RoutingPoolDefinition,
    [{ name: 'Sales', members: [member], languageFallback: ['en'] }],
    [
      { name: 'Sales', members: [member, member] },
      { name: 'Sales', members: [] },
    ],
  ],
  [
    'RulesMatcher',
    RulesMatcher,
    [
      { kind: 'dtmf', digits: '1#' },
      { kind: 'caller-id', prefixes: ['+91'] },
      { kind: 'time', hours },
      { kind: 'variable', name: 'tier', equals: ['gold'] },
      { kind: 'keywords', words: ['loan'] },
      { kind: 'phrases', phrases: ['new card'] },
      { kind: 'script', languages: ['hi'] },
    ],
    [
      { kind: 'dtmf', digits: '123456789' },
      { kind: 'caller-id', prefixes: ['91'] },
      { kind: 'keywords', words: ['x'], maxWords: 31 },
      { kind: 'regex', pattern: '.*' },
    ],
  ],
  [
    'RulesRule',
    RulesRule,
    [{ branch: 'sales', when: [{ kind: 'dtmf', digits: '1' }] }],
    [{ branch: 'sales', when: [] }],
  ],
  ['RulesEngine', RulesEngine, [node[0]!.engines[0]], [{ kind: 'rules', rules: [] }]],
  [
    'DecisionEngine',
    DecisionEngine,
    [{ kind: 'decision', instructions: 'Why are they calling?' }],
    [{ kind: 'decision', instructions: 'x', timeoutMs: 50 }],
  ],
  [
    'LlmEngine',
    LlmEngine,
    [{ kind: 'llm', instructions: 'Classify.', generatedClarify: true }],
    [{ kind: 'llm', instructions: 'x', threshold: 1.2 }],
  ],
  [
    'ExternalEngine',
    ExternalEngine,
    [external],
    [
      { kind: 'external', endpoint: 'not a url', credentialId: 'hmac' },
      { kind: 'external', endpoint: 'https://x.example', credentialId: 'hmac', slots: ['BAD'] },
    ],
  ],
  [
    'RoutingEngine',
    RoutingEngine,
    [{ kind: 'llm', instructions: 'x' }],
    [{ kind: 'jev', instructions: 'x' }],
  ],
  [
    'RoutingTarget',
    RoutingTarget,
    [
      { kind: 'pool', poolId: POOL_SALES, products: { context: 'product' }, skills: ['kyc'] },
      { kind: 'agent', agent: latest },
      { kind: 'end', line, disposition: 'closed' },
      { kind: 'callback', line, inMinutes: 30 },
      { kind: 'human', queueId: 'collections' },
    ],
    [
      { kind: 'pool', poolId: 'not-a-uuid' },
      { kind: 'callback', line, inMinutes: 1 },
      { kind: 'pool', poolId: POOL_SALES, products: { values: [] } },
    ],
  ],
  [
    'RoutingBranch',
    RoutingBranch,
    [
      { key: 'sales', description: 'Buying', next: 'product' },
      { key: 'sales', description: 'Buying', target: { kind: 'end', line } },
    ],
    [
      { key: 'sales', description: 'Buying' },
      { key: 'sales', description: 'Buying', next: 'x', target: { kind: 'end', line } },
    ],
  ],
  [
    'FallbackStep',
    FallbackStep,
    [
      { kind: 'reask' },
      { kind: 'default' },
      { kind: 'human', queueId: 'q' },
      { kind: 'end', line },
    ],
    [{ kind: 'reask', times: 4 }, { kind: 'transfer' }],
  ],
  ['RoutingNode', RoutingNode, [node[0]], [{ ...node[0], fallback: [] }]],
  [
    'RoutingPointDraft',
    RoutingPointDraft,
    [draftInput(), { ...draftInput(), limits: { maxTurns: 3, maxRouteSeconds: 30 } }],
    [
      { ...draftInput(), nodes: [] },
      { ...draftInput(), extra: true },
    ],
  ],
  [
    'PoolSnapshot',
    PoolSnapshot,
    [
      {
        id: POOL_SALES,
        version: 2,
        name: 'Sales',
        languageFallback: [],
        members: [{ ...member, agent: pinned }],
      },
    ],
    [{ id: POOL_SALES, version: 2, name: 'Sales', languageFallback: [], members: [member] }],
  ],
];

describe('routing schemas', () => {
  it.each(CASES)(
    '%s accepts its valid fixtures and refuses the invalid ones',
    (_, schema, valid, invalid) => {
      for (const input of valid) expect(schema.safeParse(input).error).toBeUndefined();
      for (const input of invalid)
        expect(schema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    },
  );

  it('applies the documented defaults', () => {
    const parsed = RoutingPointDraft.parse(draftInput());
    expect(parsed.limits).toEqual({ maxTurns: 6, maxRouteSeconds: 90 });
    expect(parsed.nodes[0]!.reuseTurn).toBe(true);
    expect(parsed.nodes[0]!.engines[1]).toMatchObject({
      threshold: 0.6,
      timeoutMs: 2_500,
      generatedClarify: false,
    });
    expect(PoolMember.parse(member)).toMatchObject({
      priority: 50,
      enabled: true,
      products: [],
      skills: [],
    });
    expect(ExternalEngine.parse(external)).toMatchObject({
      timeoutMs: 1_500,
      threshold: 0.5,
      send: { callerId: false, turnText: true, variables: [] },
      slots: [],
    });
    expect(RoutingHours.parse(hours).closed).toEqual([]);
    expect(RoutingTarget.parse({ kind: 'pool', poolId: POOL_SALES })).toMatchObject({
      language: 'caller',
      skills: [],
    });
  });

  it('bounds lines, nodes and branches', () => {
    const many = Object.fromEntries(
      ['aa', 'ab', 'ac', 'ad', 'ae', 'af', 'ag', 'ah', 'ai', 'aj', 'ak', 'al', 'am'].map((l) => [
        l,
        'x',
      ]),
    );
    expect(RouteLines.safeParse(many).success).toBe(false);
    expect(RouteLines.safeParse({ en: 'x'.repeat(501) }).success).toBe(false);
    const input = draftInput();
    expect(
      RoutingPointDraft.safeParse({ ...input, nodes: Array.from({ length: 101 }, () => node[0]) })
        .success,
    ).toBe(false);
    const branches = Array.from({ length: 33 }, (_, i) => ({
      key: `b${i}`,
      description: 'x',
      target: { kind: 'end', line },
    }));
    expect(RoutingNode.safeParse({ ...node[0], branches }).success).toBe(false);
  });
});
