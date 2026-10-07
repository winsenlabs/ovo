import { describe, expect, it } from 'vitest';
import { AgentConfig, Cap, type MediaDuplex } from '@winsendotai/ovo-contracts';
import { definePlugin, PluginRegistry } from '@winsendotai/ovo-runtime';
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

/** The turn detector row's config for an agent with `languages`, under detector `pluginId`. */
function detectorConfig(pluginId: string, languages?: { allowed: string[] }) {
  const selected = selectSessionGraph({
    release: {
      id: 'release',
      workspaceId: 'workspace',
      config: AgentConfig.parse({
        name: 'Collections',
        mode: 'agent',
        ...(languages ? { languages } : {}),
      }),
      plugins: [],
      selections: {
        engine: { pluginId: 'fixture-engine', version: '1.0.0', config: {} },
        turnDetector: { pluginId, version: '1.0.0', config: { cutoffHoldMs: 700 } },
        llm: { pluginId: 'fixture-inference', version: '1.0.0', config: {}, bindingId: 'binding' },
      },
      providerBindings: { inference: { id: 'binding', provider: 'fixture-inference' } },
    },
    registry: new PluginRegistry([
      engine('fixture-engine'),
      service(pluginId, Cap.turnDetector),
      service('fixture-inference', Cap.inference),
    ]),
    hostServices: [
      service('host-operations', Cap.operationStore, {}),
      service('host-speech', Cap.speech, {}),
    ],
    parent: [Cap.media],
    media,
    installedExtensions: { plugins: [], nativeHandlers: {} },
  });
  return selected.rows.find((row) => row.id === pluginId)?.config;
}

const DEFAULT_DETECTOR = '@winsendotai/ovo-turn-detector-default';

describe('agent languages in the session graph (N4)', () => {
  it("reach the default turn detector's config", () => {
    expect(detectorConfig(DEFAULT_DETECTOR, { allowed: ['en', 'hi'] })).toEqual({
      cutoffHoldMs: 700,
      languages: ['en', 'hi'],
    });
  });

  it('leave the detector config alone without languages, or for another detector', () => {
    expect(detectorConfig(DEFAULT_DETECTOR)).toEqual({ cutoffHoldMs: 700 });
    expect(detectorConfig('fixture-detector', { allowed: ['en'] })).toEqual({ cutoffHoldMs: 700 });
  });
});
