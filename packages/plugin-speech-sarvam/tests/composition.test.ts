import { Cap } from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { PluginRegistry, compose, definePlugin } from '@winsendotai/ovo-runtime';
import { expect, it, vi } from 'vitest';
import { sarvamSttPlugin, sarvamTtsPlugin } from '../src/index.ts';

it('loads both Sarvam speech plugins through the real runtime with root credential references', async () => {
  const resolve = vi.fn(async () => 'fixture-key');
  const host = definePlugin(
    {
      id: 'fixture-secret-resolver',
      version: '0.1.0',
      contractVersion: 1,
      scope: 'process',
      requires: [],
      provides: [Cap.secrets],
      configSchema: { type: 'object' },
      secretFields: [],
    },
    (ctx) => {
      ctx.provide(Cap.secrets, { resolve });
    },
  );
  const parent = await compose([{ id: host.manifest.id }], [host], { scope: 'process' });
  try {
    const rows = [sarvamSttPlugin, sarvamTtsPlugin].map((plugin) => ({
      id: plugin.manifest.id,
      config: { binding: {}, credentialRef: { credentialId: 'cred-1' } },
    }));
    const composition = await compose(rows, [sarvamSttPlugin, sarvamTtsPlugin], {
      scope: 'session',
      parent,
      workspaceId: 'workspace-1',
      net: createFixtureNet([]),
    });
    expect(composition.get(Cap.stt)).toBeDefined();
    expect(composition.get(Cap.tts)).toBeDefined();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledWith('workspace-1', 'cred-1');
    await composition.dispose();
  } finally {
    await parent.dispose();
  }
});

it('rejects a zero Bulbul temperature at binding validation', () => {
  const registry = new PluginRegistry([sarvamTtsPlugin]);
  expect(registry.validateBinding(sarvamTtsPlugin.manifest.id, { temperature: 0 })).toMatchObject({
    ok: false,
  });
  expect(registry.validateBinding(sarvamTtsPlugin.manifest.id, { temperature: 0.01 })).toEqual({
    ok: true,
  });
});
