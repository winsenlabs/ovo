import {
  AgentConfig,
  Cap,
  type Behavior,
  type DecisionPort,
  type Inference,
} from '@winsendotai/ovo-contracts';
import { compose, definePlugin, type PluginDefinition } from '@winsendotai/ovo-runtime';
import { describe, expect, it } from 'vitest';
import {
  createRouterBehaviorPlugin,
  parseRouterConfig,
  ROUTER_BEHAVIOR_PLUGIN_ID,
} from '../src/index.ts';
import {
  exampleRoutingSnapshot,
  EXAMPLE_IDS as I,
  fakeRoutingHost,
  fakeSegmentHandoffPort,
} from '../src/testing.ts';
import { checkedSink } from './harness.ts';

const agent = AgentConfig.parse({ name: 'Front desk', mode: 'agent', timezone: 'Asia/Kolkata' });
const config = () => ({
  agent,
  workspaceId: 'ws-1',
  sessionId: 'call-1',
  routing: exampleRoutingSnapshot(),
});

/** A host-service fixture plugin providing one capability, as the worker's host services do. */
const fixture = (key: string, value: unknown) =>
  definePlugin(
    {
      id: `fixture.${key}`,
      version: '0.1.0',
      contractVersion: 1,
      scope: 'session',
      requires: [],
      provides: [key],
      configSchema: { type: 'object' },
      secretFields: [],
    },
    (ctx) => {
      (ctx as unknown as { provide(key: string, value: unknown): void }).provide(key, value);
    },
  );

const classifier: Inference = {
  model: 'router-model',
  generate: async () => ({
    kind: 'tool',
    toolId: 'ovo_route',
    input: { branch: 'sales', confidence: 0.92, language: 'hi' },
  }),
};

async function composeRouter(
  services: PluginDefinition[],
  rowConfig: Record<string, unknown> = config(),
) {
  const plugin = createRouterBehaviorPlugin();
  return compose(
    [
      ...services.map((definition) => ({ id: definition.manifest.id })),
      { id: plugin.manifest.id, config: rowConfig },
    ],
    [...services, plugin],
  );
}

describe('createRouterBehaviorPlugin', () => {
  it('declares a v2 session behaviour that needs routing and segment handoff', () => {
    const { manifest } = createRouterBehaviorPlugin();
    expect(manifest).toMatchObject({
      id: ROUTER_BEHAVIOR_PLUGIN_ID,
      version: '0.1.0',
      contractVersion: 2,
      kind: 'behavior',
      scope: 'session',
      requires: [Cap.routing, Cap.segmentHandoff],
      optional: [Cap.inference, Cap.decision, Cap.events],
      provides: [Cap.behavior],
    });
    expect(ROUTER_BEHAVIOR_PLUGIN_ID).toBe('@winsendotai/ovo-behavior-router');
  });

  it('composes with fake host services and routes a call end to end', async () => {
    const host = fakeRoutingHost();
    const handoff = fakeSegmentHandoffPort();
    const { sink, events } = checkedSink();
    const composition = await composeRouter([
      fixture(Cap.routing, host),
      fixture(Cap.segmentHandoff, handoff),
      fixture(Cap.inference, classifier),
      fixture(Cap.events, sink),
    ]);
    try {
      const behavior = composition.ctx.get(Cap.behavior) as Behavior;
      expect(behavior.speaksFirst?.()).toBe(true);
      expect(await behavior.respond('', { inputEvent: 'opening' })).toBe(
        'Welcome to Acme. How can I help you today?',
      );
      behavior.beginTurn?.(2);
      expect(await behavior.respond('mujhe naya card chahiye')).toBe(
        'आपकी कॉल अभी जोड़ी जा रही है।',
      );
      await behavior.onPlayback?.({
        id: 'r',
        text: '',
        epoch: 2,
        state: 'completed',
        evidence: 'simulated',
      });
      expect(behavior.isComplete?.()).toBe(true);
      expect(behavior.completionReason?.()).toBe('route:agent:intent');
      expect(handoff.prepared[0]).toMatchObject({
        releaseId: I.salesHi,
        variables: { ovo_route_language: 'hi' },
      });
      expect(events.map((event) => event.type)).toEqual([
        'route.node',
        'route.node',
        'route.decision',
      ]);
      expect(events[1]!.payload).toMatchObject({
        engine: 'llm',
        modelId: 'router-model',
        outcome: 'matched',
      });
    } finally {
      await composition.dispose();
    }
    expect(handoff.abandoned).toEqual([]);
  });

  it('composes without the optional services: the llm and decision engines report disabled', async () => {
    const handoff = fakeSegmentHandoffPort();
    const composition = await composeRouter([
      fixture(Cap.routing, fakeRoutingHost()),
      fixture(Cap.segmentHandoff, handoff),
    ]);
    try {
      const behavior = composition.ctx.get(Cap.behavior) as Behavior;
      await behavior.respond('', { inputEvent: 'opening' });
      expect(await behavior.respond('I want a new card')).toBe(
        'Is it about buying something new, or an existing account?',
      );
      expect(await behavior.respond('2', { inputEvent: 'dtmf', digits: '2' })).toBe(
        'Is it about a card or a loan?',
      );
    } finally {
      await composition.dispose();
    }
  });

  it('reads the decision slot when one is selected', async () => {
    const asked: unknown[] = [];
    const decision: DecisionPort = {
      decide: async (request) => {
        asked.push(request);
        throw new Error('unreachable in this test');
      },
    };
    const routing = exampleRoutingSnapshot((raw) =>
      raw.nodes[0].engines.splice(1, 1, {
        kind: 'decision',
        instructions: 'Why is the caller calling?',
      }),
    );
    const composition = await composeRouter(
      [
        fixture(Cap.routing, fakeRoutingHost()),
        fixture(Cap.segmentHandoff, fakeSegmentHandoffPort()),
        fixture(Cap.decision, decision),
      ],
      { ...config(), routing },
    );
    try {
      const behavior = composition.ctx.get(Cap.behavior) as Behavior;
      await behavior.respond('', { inputEvent: 'opening' });
      await behavior.respond('a new card');
      expect(asked).toHaveLength(1);
    } finally {
      await composition.dispose();
    }
  });

  it('refuses to compose without the routing host or the handoff port', async () => {
    await expect(composeRouter([fixture(Cap.routing, fakeRoutingHost())])).rejects.toThrow();
    await expect(
      composeRouter([fixture(Cap.segmentHandoff, fakeSegmentHandoffPort())]),
    ).rejects.toThrow();
  });
});

describe('parseRouterConfig', () => {
  it('parses the agent and the routing snapshot', () => {
    const parsed = parseRouterConfig(config());
    expect(parsed.routing.root).toBe('intent');
    expect(parsed.agent.timezone).toBe('Asia/Kolkata');
  });

  it.each<[string, Record<string, unknown>]>([
    ['an unknown field', { ...config(), extra: true }],
    ['no routing snapshot', { agent, workspaceId: 'w', sessionId: 's' }],
    ['no session id', { agent, workspaceId: 'w', routing: exampleRoutingSnapshot() }],
    [
      'a draft instead of a release snapshot',
      { ...config(), routing: { ...exampleRoutingSnapshot(), schemaVersion: 2 } },
    ],
    [
      'an unpinned router',
      {
        ...config(),
        routing: {
          ...exampleRoutingSnapshot(),
          router: { agentId: 'a', release: { kind: 'latest' } },
        },
      },
    ],
  ])('refuses %s', (_name, raw) => {
    expect(() => parseRouterConfig(raw)).toThrow();
  });
});
