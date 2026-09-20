import { AgentConfig } from '@winsendotai/ovo-contracts';
import {
  createSessionPluginCatalog,
  nativeHandlerMarkerService,
  type InstalledSessionExtensions,
} from '@winsendotai/ovo-plugin-session';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { describe, expect, it, vi } from 'vitest';
import { ProductionVoiceSessionFactory } from '../src/production-session-factory.ts';

const PACKAGE = {
  packageName: '@example/ovo-business-tools',
  packageVersion: '1.2.3',
  pluginId: '@example/ovo-business-tools/native-handlers',
  pluginVersion: '1.2.3',
  handlerIds: ['lookup'],
} as const;

describe('production worker installed native handler pins', () => {
  it('builds the worker session catalog only for the exact installed marker pin', () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const catalog = createSessionPluginCatalog({
      config: config(),
      workspaceId: 'workspace-a',
      bindings: { inference: binding('inference', 'openai', { model: 'gpt-test' }) },
      nativeHandlers: { lookup: handler },
      nativeHandlerPackages: [PACKAGE],
      releasePlugins: [{ id: PACKAGE.pluginId, version: PACKAGE.pluginVersion }],
      output: { kind: 'simulation' },
    });

    expect(catalog.map((plugin) => plugin.manifest.id)).toContain(PACKAGE.pluginId);
    expect(
      catalog.find((plugin) => plugin.manifest.id === '@winsendotai/ovo-plugin-tools/native')
        ?.manifest.requires,
    ).toContain(nativeHandlerMarkerService(PACKAGE));
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'an old release marker',
      packages: [PACKAGE],
      plugins: [{ id: PACKAGE.pluginId, version: '1.2.2' }],
      message: 'Pinned native handler package is not installed',
    },
    {
      name: 'a missing release marker',
      packages: [PACKAGE],
      plugins: [],
      message: 'Pinned native handler package is not installed',
    },
    {
      name: 'missing installed package identity',
      packages: [],
      plugins: [{ id: PACKAGE.pluginId, version: PACKAGE.pluginVersion }],
      message: 'Native handler package identity is unavailable',
    },
  ])('fails closed before native effects for $name', async ({ packages, plugins, message }) => {
    const handler = vi.fn(async () => ({ ok: true }));
    const telemetryClose = vi.fn(async () => undefined);
    const release = releaseWithPins(plugins);
    const factory = new ProductionVoiceSessionFactory(
      {
        getRelease: async () => release,
        getCall: async () => ({
          id: 'call-a',
          workspaceId: 'workspace-a',
          releaseId: release.id,
          kind: 'live',
          status: 'active',
          createdAt: '2026-01-01T00:00:00.000Z',
          completedAt: null,
        }),
        operationStore: {},
      } as never,
      { forAgent: () => ({}) } as never,
      {
        createSession: async () => ({
          audit: vi.fn(),
          providerUsage: vi.fn(),
          inferenceUsage: vi.fn(),
          transcript: vi.fn(),
          withOperationStore: (store: unknown) => store,
          close: telemetryClose,
        }),
      } as never,
      undefined,
      undefined,
      {
        plugins: [],
        nativeHandlers: { lookup: handler },
        nativeHandlerPackages: packages,
      } satisfies InstalledSessionExtensions,
    );

    await expect(
      factory.create({
        job: {
          id: 'job-a',
          workspaceId: 'workspace-a',
          payload: { releaseId: release.id, callId: 'call-a' },
        } as never,
        route: { sessionId: 'session-a', generation: 1 } as never,
        media: {} as never,
      }),
    ).rejects.toThrow(message);
    expect(handler).not.toHaveBeenCalled();
    expect(telemetryClose).toHaveBeenCalledOnce();
  });
});

function config() {
  return AgentConfig.parse({
    name: 'Pinned native package',
    mode: 'agent',
    recording: false,
    tools: [
      {
        id: 'lookup',
        connector: 'native',
        description: 'Installed lookup',
        effect: 'read',
        inputSchema: { type: 'object' },
      },
    ],
    allowedTools: ['lookup'],
  });
}

function releaseWithPins(plugins: ReleaseRecord['plugins']): ReleaseRecord {
  return {
    id: 'release-a',
    workspaceId: 'workspace-a',
    agentId: 'agent-a',
    draftVersion: 1,
    config: config(),
    plugins,
    providerBindings: {
      inference: binding('inference', 'openai', { model: 'gpt-test' }),
      stt: binding('stt', 'deepgram', { model: 'nova-3' }),
      tts: binding('tts', 'openai', { model: 'gpt-4o-mini-tts', voice: 'alloy' }),
    },
    mcpTools: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'operator-a',
  };
}

function binding(id: string, provider: string, config: Record<string, unknown>) {
  return {
    id: `binding-${id}`,
    workspaceId: 'workspace-a',
    label: id,
    provider,
    environment: 'test',
    credentialId: `credential-${id}`,
    config,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}
