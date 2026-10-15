import { describe, expect, it } from 'vitest';
import { Cap } from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { compose, definePlugin, PluginRegistry } from '@winsendotai/ovo-runtime';
import { loadDistribution } from '../src/load.ts';

/** Wave 11 speech plugins: Cartesia Sonic TTS, Cartesia Ink STT (Auto and Manual), Rumik TTS. */
const WAVE_11 = [
  {
    id: '@winsendotai/ovo-tts-cartesia',
    kind: 'tts',
    provider: 'cartesia',
    vendor: 'Cartesia',
    binding: { voiceId: 'fixture-voice' },
    cap: Cap.tts,
  },
  {
    id: '@winsendotai/ovo-stt-cartesia',
    kind: 'stt',
    provider: 'cartesia',
    vendor: 'Cartesia',
    binding: {},
    cap: Cap.stt,
  },
  {
    id: '@winsendotai/ovo-stt-cartesia-manual',
    kind: 'stt',
    provider: 'cartesia-manual',
    vendor: 'Cartesia',
    binding: {},
    cap: Cap.stt,
  },
  {
    id: '@winsendotai/ovo-tts-rumik',
    kind: 'tts',
    provider: 'rumik',
    vendor: 'Rumik',
    binding: { description: 'A calm, warm Indian English voice.' },
    cap: Cap.tts,
  },
] as const;

describe('Wave 11 speech catalog', () => {
  it.each(['api', 'gateway'] as const)(
    'the %s profile offers Cartesia and Rumik with their fixture templates',
    async (role) => {
      const loaded = await loadDistribution({ role, profile: 'compose', env: {}, log: () => {} });
      const registry = new PluginRegistry(loaded.catalog);
      for (const plugin of WAVE_11) {
        expect(registry.get(plugin.id)?.manifest, plugin.id).toMatchObject({
          kind: plugin.kind,
          provider: plugin.provider,
          ui: { slot: plugin.kind, vendor: plugin.vendor },
        });
        expect(registry.resolve(plugin.kind, plugin.provider).manifest.id).toBe(plugin.id);
        expect(loaded.fixtureTemplates[plugin.id], plugin.id).toBeTypeOf('function');
        expect(loaded.fixtures[plugin.id]?.length, plugin.id).toBeGreaterThan(0);
      }
    },
  );

  it.each(WAVE_11)(
    'composes $id from the production catalog over its fixture scripts',
    async (plugin) => {
      const installed = await loadDistribution({ role: 'gateway', profile: 'compose', env: {} });
      const resolver = definePlugin(
        {
          id: 'speech-catalog-secrets',
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
        const definition = installed.catalog.find((entry) => entry.manifest.id === plugin.id)!;
        const graph = await compose(
          [
            {
              id: plugin.id,
              config: { binding: plugin.binding, credentialRef: { credentialId: 'fixture' } },
            },
          ],
          [definition],
          {
            scope: 'session',
            parent,
            workspaceId: 'workspace',
            net: createFixtureNet(installed.fixtures[plugin.id] ?? []),
          },
        );
        try {
          expect(graph.get(plugin.cap)).toBeDefined();
        } finally {
          await graph.dispose();
        }
      } finally {
        await parent.dispose();
      }
    },
  );
});
