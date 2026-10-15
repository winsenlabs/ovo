import { describe, expect, it } from 'vitest';
import { RoutingNode, type RoutingReleaseSnapshot } from '@winsendotai/ovo-contracts';
import { createRulesRunner, type RouteTurn } from '../src/engines/index.ts';
import { evaluateTurn } from '../src/evaluate.ts';
import { RouteRecorder } from '../src/events.ts';
import { initialState, nodeMap, type RouterState } from '../src/state.ts';
import {
  exampleRoutingSnapshot,
  fakeRoutingHost,
  scriptedEngines,
  type EngineScript,
} from '../src/testing.ts';

async function evaluate(
  script: EngineScript,
  turn: RouteTurn | undefined,
  options: { snapshot?: RoutingReleaseSnapshot; state?: (state: RouterState) => void } = {},
) {
  const snapshot = options.snapshot ?? exampleRoutingSnapshot();
  const state = initialState(snapshot);
  options.state?.(state);
  const recorder = new RouteRecorder();
  const engines = scriptedEngines(script, { rules: createRulesRunner(fakeRoutingHost()) });
  const evaluation = await evaluateTurn(state, turn, {
    snapshot,
    nodes: nodeMap(snapshot),
    runners: engines.runners,
    recorder,
    now: () => 0,
    signal: new AbortController().signal,
  });
  return {
    kind: evaluation.kind,
    node: evaluation.node.id,
    clarify: evaluation.kind === 'undecided' ? evaluation.clarify : undefined,
    events: recorder.events.map((event) => event.payload),
    path: state.path,
    context: state.context,
    calls: engines.calls.map((call) => `${call.node}:${call.kind}`),
  };
}

const node = (n: string, engine: string, outcome: string, extra: Record<string, unknown> = {}) => ({
  turn: 0,
  node: n,
  engine,
  outcome,
  ...(engine === 'context' ? {} : { ms: 0 }),
  ...extra,
});

describe('evaluateTurn: engines in order', () => {
  it.each<[string, EngineScript, RouteTurn, string, unknown[]]>([
    [
      'a keypad rule decides before the LLM is asked',
      {},
      { digits: '1' },
      'target',
      [node('intent', 'rules', 'matched', { branch: 'sales', confidence: 1 })],
    ],
    [
      'rules miss, the LLM matches',
      {
        intent: { llm: [{ outcome: 'matched', branch: 'sales', confidence: 0.9, modelId: 'm1' }] },
      },
      { text: 'I want to buy' },
      'target',
      [
        node('intent', 'rules', 'no_match'),
        node('intent', 'llm', 'matched', { branch: 'sales', confidence: 0.9, modelId: 'm1' }),
      ],
    ],
    [
      'low confidence decides nothing',
      { intent: { llm: [{ outcome: 'low_confidence', branch: 'sales', confidence: 0.3 }] } },
      { text: 'hmm' },
      'undecided',
      [
        node('intent', 'rules', 'no_match'),
        node('intent', 'llm', 'low_confidence', { branch: 'sales', confidence: 0.3 }),
      ],
    ],
    [
      'a timeout decides nothing',
      { intent: { llm: [{ outcome: 'timeout' }] } },
      { text: 'hmm' },
      'undecided',
      [node('intent', 'rules', 'no_match'), node('intent', 'llm', 'timeout')],
    ],
    [
      'a matched branch the node lacks is an error',
      { intent: { llm: [{ outcome: 'matched', branch: 'billing', confidence: 1 }] } },
      { text: 'bill' },
      'undecided',
      [
        node('intent', 'rules', 'no_match'),
        node('intent', 'llm', 'error', {
          branch: 'billing',
          confidence: 1,
          reason: 'unknown_branch',
        }),
      ],
    ],
  ])('%s', async (_name, script, turn, kind, events) => {
    const result = await evaluate(script, turn);
    expect(result.kind).toBe(kind);
    expect(result.events).toEqual(events);
  });

  it('runs only instant engines on the opening', async () => {
    const result = await evaluate({}, undefined);
    expect(result).toMatchObject({ kind: 'undecided', node: 'intent', events: [], calls: [] });
  });

  it('keeps a detected language and a generated question even when nothing matched', async () => {
    const result = await evaluate(
      {
        intent: {
          llm: [
            {
              outcome: 'low_confidence',
              confidence: 0.2,
              language: 'hi',
              clarify: 'Naya ya purana?',
            },
          ],
        },
      },
      { text: 'haan ji' },
    );
    expect(result).toMatchObject({
      kind: 'undecided',
      clarify: 'Naya ya purana?',
      context: { language: 'hi' },
    });
  });

  it('ignores a detected language the release does not allow', async () => {
    const result = await evaluate(
      { intent: { llm: [{ outcome: 'matched', branch: 'sales', confidence: 1, language: 'fr' }] } },
      { text: 'bonjour' },
    );
    expect(result.context.language).toBeUndefined();
  });
});

describe('evaluateTurn: context and chaining', () => {
  it('prefills from the context without running an engine', async () => {
    const result = await evaluate(
      {},
      { text: 'card' },
      { state: (state) => (state.context.values.intent = 'sales') },
    );
    expect(result).toMatchObject({ kind: 'target', calls: [] });
    expect(result.events).toEqual([
      node('intent', 'context', 'matched', { branch: 'sales', confidence: 1 }),
    ]);
  });

  it('follows next on the same turn and stores each chosen key', async () => {
    const result = await evaluate(
      { intent: { llm: [{ outcome: 'matched', branch: 'support', confidence: 0.8 }] } },
      { text: 'my card is blocked' },
    );
    expect(result).toMatchObject({ kind: 'target', node: 'product', path: ['intent', 'product'] });
    expect(result.context.values).toEqual({ intent: 'support', product: 'cards' });
    expect(result.events.at(-1)).toEqual(
      node('product', 'rules', 'matched', { branch: 'cards', confidence: 1 }),
    );
  });

  it('asks the next node when it cannot decide on the same turn', async () => {
    const result = await evaluate(
      { intent: { llm: [{ outcome: 'matched', branch: 'support', confidence: 0.8 }] } },
      { text: 'there is a problem' },
    );
    expect(result).toMatchObject({ kind: 'ask', node: 'product', path: ['intent', 'product'] });
  });

  it('does not reuse the turn for a node without reuseTurn', async () => {
    const snapshot = exampleRoutingSnapshot((raw) => (raw.nodes[1].reuseTurn = false));
    const result = await evaluate(
      { intent: { llm: [{ outcome: 'matched', branch: 'support', confidence: 0.8 }] } },
      { text: 'my card is blocked' },
      { snapshot },
    );
    expect(result).toMatchObject({ kind: 'ask', node: 'product' });
    expect(result.calls).toEqual(['intent:rules', 'intent:llm']);
  });

  it('applies slots to the context and lets them prefill the next node', async () => {
    const snapshot = exampleRoutingSnapshot((raw) => {
      raw.nodes[0].engines = [
        {
          kind: 'external',
          endpoint: 'https://x.example.com',
          credentialId: 'c',
          slots: ['product'],
        },
      ];
    });
    const result = await evaluate(
      {
        intent: {
          external: [
            { outcome: 'matched', branch: 'support', confidence: 1, slots: { product: 'loans' } },
          ],
        },
      },
      { text: 'my loan' },
      { snapshot },
    );
    expect(result).toMatchObject({
      kind: 'target',
      node: 'product',
      context: { values: { intent: 'support', product: 'loans' } },
    });
    expect(result.events.at(-1)).toEqual(
      node('product', 'context', 'matched', { branch: 'loans', confidence: 1 }),
    );
    expect(result.calls).toEqual(['intent:external']);
  });

  it('evaluates at most eight nodes on one turn, even in a tree publish would refuse', async () => {
    const chain = Array.from({ length: 10 }, (_, index) =>
      RoutingNode.parse({
        id: `n${index}`,
        ask: { en: `Question ${index}?` },
        engines: [
          {
            kind: 'rules',
            rules: [{ branch: 'go', when: [{ kind: 'keywords', words: ['yes'] }] }],
          },
        ],
        branches: [
          index === 9
            ? { key: 'go', description: 'go', target: { kind: 'end', line: { en: 'Bye.' } } }
            : { key: 'go', description: 'go', next: `n${index + 1}` },
        ],
        fallback: [{ kind: 'end', line: { en: 'Bye.' } }],
      }),
    );
    // Ten levels is `routing_depth_exceeded`, so the snapshot is built past its validation.
    const snapshot = { ...exampleRoutingSnapshot(), root: 'n0', nodes: chain };
    const result = await evaluate({}, { text: 'yes' }, { snapshot });
    expect(result).toMatchObject({ kind: 'ask', node: 'n8' });
    expect(result.path).toHaveLength(9);
    expect(result.events).toHaveLength(8);
  });
});
