import { AgentConfig, Cap, MULAW_8K } from '@winsendotai/ovo-contracts';
import { definePlugin, PluginRegistry } from '@winsendotai/ovo-runtime';
import { expect, it } from 'vitest';
import { buildReleaseSelections } from '../src/release-selections.ts';

it('snapshots a same-major engine companion even when its minor version differs', async () => {
  const companion = definePlugin(
    {
      id: '@fixture/speech-companion',
      version: '1.2.0',
      contractVersion: 1,
      scope: 'session',
      provides: [Cap.speech],
      requires: [],
      configSchema: { type: 'object' },
      secretFields: [],
    },
    () => undefined,
  );
  const engine = definePlugin(
    {
      id: '@fixture/engine',
      version: '1.0.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'engine',
      provider: 'fixture',
      provides: [`${Cap.engine}@2`],
      requires: [],
      companions: { [Cap.speech]: companion.manifest.id },
      configSchema: { type: 'object' },
      secretFields: [],
      capabilities: {
        turnDetection: ['provider'],
        bargeIn: true,
        dtmf: true,
        confirmedPlayback: true,
        ownsProviders: false,
        formats: [MULAW_8K],
        consumesTurnDetector: false,
      },
      runtime: { egressHosts: [], modelLicences: [] },
      conformance: ['engine@1'],
    },
    () => undefined,
  );
  const agent = {
    workspaceId: 'workspace',
    config: AgentConfig.parse({
      name: 'Notice',
      mode: 'announcement',
      voice: { engine: { plugin: engine.manifest.id, config: {} } },
    }),
  } as never;
  const selections = await buildReleaseSelections({
    agent,
    store: {} as never,
    registry: new PluginRegistry([engine, companion]),
    defaults: { engine: engine.manifest.id },
  });
  expect(selections['companion:ovo.speech']).toMatchObject({
    pluginId: companion.manifest.id,
    version: '1.2.0',
  });
});
