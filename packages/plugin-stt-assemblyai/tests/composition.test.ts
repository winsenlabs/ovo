import { AgentConfig, Cap } from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { PluginRegistry, compose, definePlugin } from '@winsendotai/ovo-runtime';
import { expect, it, vi } from 'vitest';
import { validateSelections } from '../../session-host/src/compat/index.ts';
import { assemblyAiPlugin } from '../src/index.ts';

it('admits the default en-IN release through the actual host language rule', () => {
  const issues = validateSelections(
    {
      config: AgentConfig.parse({ name: 'AssemblyAI default', mode: 'announcement' }),
      selections: {
        stt: {
          pluginId: assemblyAiPlugin.manifest.id,
          version: assemblyAiPlugin.manifest.version,
          bindingId: 'assemblyai-binding',
          binding: {
            provider: 'assemblyai',
            config: { model: 'universal-streaming-english' },
            credentialId: 'fixture-credential',
            fingerprint: 'fixture-fingerprint',
            updatedAt: '2026-09-26',
          },
          config: {},
        },
      },
      registry: new PluginRegistry([assemblyAiPlugin]),
    },
    'live',
  );
  expect(issues.filter((issue) => issue.code === 'language_unsupported')).toEqual([]);
});

it('loads AssemblyAI through the real runtime with a root credential reference', async () => {
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
    const composition = await compose(
      [
        {
          id: assemblyAiPlugin.manifest.id,
          config: { binding: {}, credentialRef: { credentialId: 'cred-1' } },
        },
      ],
      [assemblyAiPlugin],
      {
        scope: 'session',
        parent,
        workspaceId: 'workspace-1',
        net: createFixtureNet([]),
      },
    );
    expect(composition.get(Cap.stt)).toBeDefined();
    expect(resolve).toHaveBeenCalledExactlyOnceWith('workspace-1', 'cred-1');
    await composition.dispose();
  } finally {
    await parent.dispose();
  }
});
