import { expect, it, vi } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { createNativeConnector } from '@winsendotai/ovo-plugin-tools';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { createSessionPluginCatalog, loadInstalledSessionExtensions } from '../src/index.ts';

it('dynamically installs, configures and runs an exactly pinned native handler package', async () => {
  const load = vi.fn(async () => loadFixture());
  const extensions = await loadInstalledSessionExtensions('["@example/ovo-business-tools"]', load);
  expect(load).toHaveBeenCalledWith('@example/ovo-business-tools');
  expect(extensions.nativeHandlerPackages).toEqual([
    {
      packageName: '@example/ovo-business-tools',
      packageVersion: '1.2.3',
      pluginId: '@example/ovo-business-tools/native-handlers',
      pluginVersion: '1.2.3',
      handlerIds: ['lookup'],
    },
  ]);
  expect(extensions.plugins[0]?.manifest).toMatchObject({
    id: '@example/ovo-business-tools/native-handlers',
    version: '1.2.3',
    scope: 'session',
  });
  const connector = createNativeConnector(extensions.nativeHandlers);
  await expect(
    connector.invoke(
      {
        id: 'lookup',
        connector: 'native',
        description: 'Installed lookup',
        effect: 'read',
        confirmation: false,
        timeoutMs: 5_000,
        inputSchema: { type: 'object' },
      },
      { query: 'configured without host source changes' },
      {
        signal: new AbortController().signal,
        operationId: 'operation-1',
        workspaceId: 'local',
      },
    ),
  ).resolves.toEqual({
    configured: { query: 'configured without host source changes' },
    operationId: 'operation-1',
    workspaceId: 'local',
  });
});

it('rejects network and filesystem imports before loading', async () => {
  const load = vi.fn(async () => ({}));
  for (const name of [
    'https://example.com/plugin.js',
    'file:///opt/plugin.js',
    '../plugin',
    'node:child_process',
  ])
    await expect(loadInstalledSessionExtensions(JSON.stringify([name]), load)).rejects.toThrow(
      'installed package identifiers',
    );
  expect(load).not.toHaveBeenCalled();
  await expect(
    loadInstalledSessionExtensions('["one","two"]', async (name) => ({
      nativeHandlers: {
        package: { name, version: '1.0.0' },
        plugin: { id: `${name}/native-handlers`, version: '1.0.0' },
        handlers: { lookup: async () => ({}) },
      },
    })),
  ).rejects.toThrow('duplicate native handler');
});

it('requires package-bound plugin identity and rejects an old release pin', async () => {
  await expect(
    loadInstalledSessionExtensions('["@example/ovo-tools"]', async () => ({
      nativeHandlers: { lookup: async () => ({}) },
    })),
  ).rejects.toThrow('exact package and plugin identity');

  const extensions = await loadInstalledSessionExtensions(
    '["@example/ovo-business-tools"]',
    async () => loadFixture(),
  );
  const config = AgentConfig.parse({
    name: 'Pinned extension',
    mode: 'agent',
    allowedTools: ['lookup'],
    tools: [
      {
        id: 'lookup',
        connector: 'native',
        description: 'Installed lookup',
        effect: 'read',
        inputSchema: { type: 'object' },
      },
    ],
  });
  expect(() =>
    createSessionPluginCatalog({
      config,
      workspaceId: 'local',
      bindings: {},
      output: { kind: 'simulation' },
      inferencePlugin: fixtureInference(),
      nativeHandlers: extensions.nativeHandlers,
      nativeHandlerPackages: extensions.nativeHandlerPackages,
      releasePlugins: [{ id: '@example/ovo-business-tools/native-handlers', version: '1.2.2' }],
    }),
  ).toThrow('Pinned native handler package is not installed');
});

function fixtureInference() {
  return definePlugin(
    {
      id: 'fixture.inference',
      version: '1.0.0',
      contractVersion: 1,
      scope: 'session',
      requires: [],
      provides: ['ovo.inference'],
      configSchema: {},
      secretFields: [],
    },
    () => undefined,
  );
}

function loadFixture(): Promise<unknown> {
  return import(new URL('./fixtures/installed-native-extension.mjs', import.meta.url).href);
}
