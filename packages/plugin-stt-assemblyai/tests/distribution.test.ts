import { Cap } from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { expect, it } from 'vitest';
import { loadDistribution } from '../../distribution/src/load.ts';

it.each([
  ['@winsendotai/ovo-stt-assemblyai', Cap.stt],
  ['@winsendotai/ovo-stt-elevenlabs', Cap.stt],
  ['@winsendotai/ovo-stt-sarvam', Cap.stt],
  ['@winsendotai/ovo-tts-sarvam', Cap.tts],
] as const)('loads and composes %s from the production distribution', async (id, capability) => {
  const installed = await loadDistribution({ role: 'gateway', profile: 'compose', env: {} });
  const resolver = definePlugin(
    {
      id: 's2-test-secrets',
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
  const parent = await compose([{ id: resolver.manifest.id }], [resolver], { scope: 'process' });
  try {
    const definition = installed.catalog.find((plugin) => plugin.manifest.id === id);
    expect(definition, `${id} must be installed by the production catalog`).toBeDefined();
    const graph = await compose(
      [{ id, config: { binding: {}, credentialRef: { credentialId: 'fixture' } } }],
      [definition!],
      { scope: 'session', parent, workspaceId: 'workspace', net: createFixtureNet([]) },
    );
    try {
      expect(graph.get(capability)).toBeDefined();
    } finally {
      await graph.dispose();
    }
  } finally {
    await parent.dispose();
  }
});
