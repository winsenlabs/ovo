import { describe, expect, it } from 'vitest';
import { AgentConfig, Cap, type MediaDuplex } from '@winsendotai/ovo-contracts';
import { BEHAVIOR_PLUGIN_IDS } from '@winsendotai/ovo-behaviors';
import { definePlugin, PluginRegistry, type PluginDefinition } from '@winsendotai/ovo-runtime';
import { selectSessionGraph } from '../src/select-session-graph.ts';

const plugin = (id: string, provides: string[], requires: string[] = []) =>
  definePlugin(
    {
      id,
      version: '1.0.0',
      contractVersion: 1,
      scope: 'session',
      provides,
      requires,
      configSchema: { type: 'object' },
      secretFields: [],
    },
    (ctx) => {
      for (const key of provides) ctx.provide(key, (() => undefined) as never);
    },
  );
const engine = definePlugin(
  {
    id: 'fixture-engine',
    version: '1.0.0',
    contractVersion: 2,
    scope: 'session',
    kind: 'engine',
    provider: 'fixture',
    provides: [`${Cap.engine}@2`],
    requires: [Cap.behavior, Cap.media],
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
  () => undefined,
);
// A host service only the replacement behaviour asks for.
const clock = plugin('host-clock', [Cap.clock]);
const media = {
  sessionId: 'session-1',
  format: { encoding: 'mulaw', sampleRate: 8000, channels: 1 },
} as MediaDuplex;

function input(behavior?: { definition: PluginDefinition; config: Record<string, unknown> }) {
  return {
    release: {
      id: 'release',
      workspaceId: 'workspace',
      config: AgentConfig.parse({ name: 'announce', mode: 'announcement', message: 'Hello.' }),
      plugins: [],
      selections: { engine: { pluginId: 'fixture-engine', version: '1.0.0', config: {} } },
    },
    registry: new PluginRegistry([engine]),
    hostServices: [clock],
    parent: [],
    media,
    installedExtensions: { plugins: [], nativeHandlers: {} },
    ...(behavior ? { behavior } : {}),
  };
}

describe('the behaviour override (routing design 7.3)', () => {
  it('leaves the release behaviour row, its config and the services unchanged without one', () => {
    const selected = selectSessionGraph(input());
    const ids = selected.rows.map((row) => row.id);
    expect(ids).toContain(BEHAVIOR_PLUGIN_IDS.announcement);
    expect(ids).not.toContain('host-clock');
    expect(
      selected.rows.find((row) => row.id === BEHAVIOR_PLUGIN_IDS.announcement)?.config,
    ).toEqual({
      agent: input().release.config,
      workspaceId: 'workspace',
      sessionId: 'session-1',
    });
  });

  it('replaces the behaviour row and catalog entry and pulls in the services it needs', () => {
    const router = plugin('fixture-router', [Cap.behavior], [Cap.clock]);
    const config = { routing: { root: 'intent' } };
    const selected = selectSessionGraph(input({ definition: router, config }));
    const ids = selected.rows.map((row) => row.id);
    expect(ids).not.toContain(BEHAVIOR_PLUGIN_IDS.announcement);
    expect(selected.catalog.map((item) => item.manifest.id)).not.toContain(
      BEHAVIOR_PLUGIN_IDS.announcement,
    );
    expect(selected.rows.find((row) => row.id === 'fixture-router')?.config).toBe(config);
    expect(ids).toContain('host-clock');
  });
});
