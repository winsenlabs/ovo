import { describe, expect, it } from 'vitest';
import { AgentConfig, Cap, type MediaDuplex } from '@winsendotai/ovo-contracts';
import { compose, definePlugin, PluginRegistry } from '@winsendotai/ovo-runtime';
import { selectSessionGraph } from '../src/select-session-graph.ts';

const service = (id: string, key: string, value: unknown = () => undefined) =>
  definePlugin(
    {
      id,
      version: '1.0.0',
      contractVersion: 1,
      scope: 'session',
      provides: [key],
      requires: [],
      configSchema: { type: 'object' },
      secretFields: [],
    },
    (ctx) => {
      ctx.provide(key, value as never);
    },
  );
const decision = service('fixture-decision', Cap.decision, { decide: async () => ({}) });
const media = {
  sessionId: 'session',
  carrierId: 'carrier',
  format: { encoding: 'mulaw', sampleRate: 8000, channels: 1 },
  playbackEvidence: 'carrier-played',
} as MediaDuplex;
const agent = (over: Record<string, unknown> = {}) =>
  AgentConfig.parse({
    name: 'Jev-only',
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
    ...over,
  });
const input = (config: AgentConfig) => ({
  release: {
    id: 'release',
    workspaceId: 'workspace',
    config,
    plugins: [],
    selections: { decision: { pluginId: 'fixture-decision', version: '1.0.0', config: {} } },
  },
  registry: new PluginRegistry([decision]),
  // The execution plugin every agent composes needs these from the host.
  hostServices: [
    service('host-operations', Cap.operationStore, {}),
    service('host-speech', Cap.speech, {}),
  ],
  parent: [Cap.media],
  media,
  installedExtensions: { plugins: [], nativeHandlers: {} },
});

describe('Jev-only session graph (AGT-4)', () => {
  it('composes an agent that reaches no LLM without an inference plugin', async () => {
    const selected = selectSessionGraph(input(agent()));
    expect(
      selected.catalog.some((definition) => definition.manifest.provides.includes(Cap.inference)),
    ).toBe(false);
    const graph = await compose(selected.rows, selected.catalog, { scope: 'session' });
    const behavior = graph.get(Cap.behavior) as { respond(input: string): Promise<string> };
    expect(behavior).toBeDefined();
    await graph.dispose();
  });

  it('still requires live inference for an agent some path routes to the LLM', () => {
    expect(() => selectSessionGraph(input(agent({ decisionUnavailable: undefined })))).toThrow(
      'Live inference selection is required',
    );
  });
});
