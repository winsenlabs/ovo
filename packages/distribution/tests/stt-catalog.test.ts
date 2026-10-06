import { describe, expect, it } from 'vitest';
import { Cap } from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { compose, definePlugin, PluginRegistry } from '@winsendotai/ovo-runtime';
import { loadDistribution } from '../src/load.ts';

const REALTIME = '@winsendotai/ovo-stt-openai-realtime';

describe('STT catalog (STT-12)', () => {
  it.each(['api', 'gateway'] as const)(
    'the %s profile offers OpenAI realtime transcription as an STT binding',
    async (role) => {
      const loaded = await loadDistribution({ role, profile: 'compose', env: {}, log: () => {} });
      const registry = new PluginRegistry(loaded.catalog);
      expect(registry.get(REALTIME)?.manifest).toMatchObject({
        kind: 'stt',
        provider: 'openai',
        ui: { slot: 'stt', vendor: 'OpenAI' },
      });
      expect(registry.resolve('stt', 'openai').manifest.id).toBe(REALTIME);
      expect(loaded.fixtureTemplates[REALTIME]).toBeTypeOf('function');
    },
  );

  it('composes the plugin from the production catalog with a resolved credential', async () => {
    const installed = await loadDistribution({ role: 'gateway', profile: 'compose', env: {} });
    const resolver = definePlugin(
      {
        id: 'stt-catalog-secrets',
        version: '0.1.0',
        contractVersion: 1,
        scope: 'process',
        provides: [Cap.secrets],
        requires: [],
        configSchema: { type: 'object' },
        secretFields: [],
      },
      (ctx) => {
        ctx.provide(Cap.secrets, { resolve: async () => 'fixture-key' });
      },
    );
    const parent = await compose([{ id: resolver.manifest.id }], [resolver], {
      scope: 'process',
    });
    try {
      const definition = installed.catalog.find((plugin) => plugin.manifest.id === REALTIME)!;
      const graph = await compose(
        [{ id: REALTIME, config: { binding: {}, credentialRef: { credentialId: 'fixture' } } }],
        [definition],
        { scope: 'session', parent, workspaceId: 'workspace', net: createFixtureNet([]) },
      );
      try {
        expect(graph.get(Cap.stt)).toBeDefined();
      } finally {
        await graph.dispose();
      }
    } finally {
      await parent.dispose();
    }
  });
});
