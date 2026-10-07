import { describe, expect, it } from 'vitest';
import { AgentConfig, Cap, type MediaDuplex } from '@winsendotai/ovo-contracts';
import { definePlugin, PluginRegistry } from '@winsendotai/ovo-runtime';
import { STREAMING_VOICE_PLUGIN_IDS } from '@winsendotai/ovo-plugin-voice';
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
const engine = (id: string) =>
  definePlugin(
    {
      id,
      version: '1.0.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'engine',
      provider: 'fixture',
      provides: [`${Cap.engine}@2`],
      requires: [Cap.media],
      configSchema: { type: 'object' },
      secretFields: [],
      capabilities: {
        turnDetection: ['provider'],
        bargeIn: true,
        dtmf: true,
        confirmedPlayback: true,
        ownsProviders: false,
        formats: [{ encoding: 'mulaw', sampleRate: 8000, channels: 1 }],
        consumesTurnDetector: false,
      },
      runtime: { egressHosts: [], modelLicences: [] },
      conformance: ['engine@1'],
    } as never,
    (ctx) => {
      ctx.provide(Cap.engine as never, { start: async () => undefined } as never);
    },
  );
const media = {
  sessionId: 'session',
  carrierId: 'carrier',
  format: { encoding: 'mulaw', sampleRate: 8000, channels: 1 },
  playbackEvidence: 'carrier-played',
} as MediaDuplex;
const LINE = "I'm sorry, we need to end the call now. Thank you, goodbye.";

/** The engine row's `engine` config for an agent with a wrap-up line, under engine `pluginId`. */
function engineConfig(pluginId: string) {
  const selected = selectSessionGraph({
    release: {
      id: 'release',
      workspaceId: 'workspace',
      config: AgentConfig.parse({
        name: 'Collections',
        mode: 'agent',
        ending: { wrapUp: { line: LINE, leadSeconds: 20 } },
      }),
      plugins: [],
      selections: {
        engine: { pluginId, version: '1.0.0', config: { prefetchSegments: 2 } },
        llm: { pluginId: 'fixture-inference', version: '1.0.0', config: {}, bindingId: 'binding' },
      },
      providerBindings: { inference: { id: 'binding', provider: 'fixture-inference' } },
    },
    registry: new PluginRegistry([engine(pluginId), service('fixture-inference', Cap.inference)]),
    // The execution plugin every agent composes needs these from the host.
    hostServices: [
      service('host-operations', Cap.operationStore, {}),
      service('host-speech', Cap.speech, {}),
    ],
    parent: [Cap.media],
    media,
    installedExtensions: { plugins: [], nativeHandlers: {} },
  });
  return selected.rows.find((row) => row.id === pluginId)?.config?.engine;
}

describe('AgentEnding.wrapUp in the session graph', () => {
  it('reaches the native engine with its own config', () => {
    expect(engineConfig(STREAMING_VOICE_PLUGIN_IDS.sessionEngine)).toEqual({
      prefetchSegments: 2,
      wrapUp: { line: LINE, leadSeconds: 20 },
    });
  });

  it('is not passed to another engine, whose schema may not accept it', () => {
    expect(engineConfig('fixture-engine')).toEqual({ prefetchSegments: 2 });
  });
});
