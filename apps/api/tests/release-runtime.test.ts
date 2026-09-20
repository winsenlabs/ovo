import { describe, expect, it, vi } from 'vitest';
import {
  createAnnouncementBehaviorPlugin,
  createFaqBehaviorPlugin,
} from '@winsendotai/ovo-behaviors';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import type { AgentDraft, ControlStore, ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import {
  createSessionServicesPlugin,
  runRelease,
  validateRelease,
} from '../src/release-runtime.ts';

const config = AgentConfig.parse({
  name: 'Reminder',
  mode: 'announcement',
  message: 'Hello',
  variables: { type: 'object', properties: {}, additionalProperties: false },
});
const agent: AgentDraft = {
  id: 'agent-a',
  workspaceId: 'workspace-a',
  config,
  draftVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const services = createSessionServicesPlugin(
  { createIntent: async () => true, get: async () => undefined, settle: async () => undefined },
  { resolve: async () => '' },
  {},
);
const store = {} as ControlStore;

describe('immutable release runtime', () => {
  it('does not approve a different remote MCP tool with an identical schema', async () => {
    const configured = AgentConfig.parse({
      name: 'Fixture',
      mode: 'announcement',
      allowedTools: ['check'],
      tools: [
        {
          id: 'check',
          description: 'check',
          connector: 'mcp',
          connectionId: 'connection',
          remoteName: 'deleteAccount',
          schemaDigest: 'same-schema',
          inputSchema: { type: 'object' },
          effect: 'write',
        },
      ],
    });
    const approvalStore = {
      getMcpApproval: async () => ({
        connectionId: 'connection',
        remoteName: 'getAccount',
        schemaDigest: 'same-schema',
      }),
      getMcpDiscoveredTool: async () => ({
        remoteName: 'getAccount',
        schemaDigest: 'same-schema',
      }),
    } as unknown as ControlStore;
    await expect(
      validateRelease({ ...agent, config: configured }, [], approvalStore, [], services),
    ).rejects.toThrow('not currently approved');
  });

  it.each(['inputSchema', 'outputSchema'] as const)(
    'rejects changed %s despite an unchanged claimed digest',
    async (field) => {
      const tool = {
        id: 'check',
        description: 'check',
        connector: 'mcp',
        connectionId: 'connection',
        remoteName: 'getAccount',
        schemaDigest: 'same-schema',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        effect: 'read',
      };
      const configured = AgentConfig.parse({
        name: 'Fixture',
        mode: 'announcement',
        allowedTools: ['check'],
        tools: [
          { ...tool, [field]: { type: 'object', properties: { injected: { type: 'string' } } } },
        ],
      });
      const approvalStore = {
        getMcpApproval: async () => ({
          connectionId: 'connection',
          remoteName: 'getAccount',
          schemaDigest: 'same-schema',
        }),
        getMcpDiscoveredTool: async () => ({
          remoteName: 'getAccount',
          schemaDigest: 'same-schema',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
        }),
      } as unknown as ControlStore;
      await expect(
        validateRelease({ ...agent, config: configured }, [], approvalStore, [], services),
      ).rejects.toThrow('not currently approved');
    },
  );

  it('fails closed before applying a same-ID replacement with a different version', async () => {
    const applied = vi.fn(),
      replacement = definePlugin(
        {
          id: 'fixture.behavior',
          version: '2.0.0',
          contractVersion: 1,
          scope: 'session',
          provides: ['ovo.behavior'],
          requires: [],
          configSchema: { type: 'object' },
          secretFields: [],
        },
        (ctx) => {
          applied();
          ctx.provide('ovo.behavior', { respond: async () => 'replacement' });
        },
      );
    const release: ReleaseRecord = {
      id: 'release-a',
      workspaceId: 'workspace-a',
      agentId: 'agent-a',
      draftVersion: 1,
      config,
      plugins: [{ id: 'fixture.behavior', version: '1.0.0' }],
      providerBindings: {},
      mcpTools: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'admin',
    };
    await expect(
      runRelease(release, [replacement], services, 'hello', {}, 'session-a'),
    ).rejects.toThrow('Pinned plugin is not installed: fixture.behavior@1.0.0');
    const mcpConfig = AgentConfig.parse({
      ...config,
      allowedTools: ['lookup'],
      tools: [
        {
          id: 'lookup',
          description: 'Lookup',
          connector: 'mcp',
          connectionId: 'connection-a',
          remoteName: 'lookup',
          schemaDigest: 'sha256:lookup',
          inputSchema: { type: 'object' },
          effect: 'read',
        },
      ],
    });
    await expect(
      runRelease(
        { ...release, config: mcpConfig },
        [replacement],
        services,
        'hello',
        {},
        'session-a',
      ),
    ).rejects.toThrow('Release is missing immutable MCP snapshot for lookup');
    expect(applied).not.toHaveBeenCalled();
  });

  it('requires exactly one mode-compatible behavior provider', async () => {
    const announcement = createAnnouncementBehaviorPlugin(),
      faq = createFaqBehaviorPlugin();
    await expect(
      validateRelease(
        agent,
        [{ id: faq.manifest.id, version: faq.manifest.version }],
        store,
        [faq],
        services,
      ),
    ).rejects.toThrow('incompatible with mode announcement');
    await expect(
      validateRelease(
        agent,
        [
          { id: announcement.manifest.id, version: announcement.manifest.version },
          { id: faq.manifest.id, version: faq.manifest.version },
        ],
        store,
        [announcement, faq],
        services,
      ),
    ).rejects.toThrow('exactly one ovo.behavior');
  });

  it('rejects unrelated or non-session plugins from a release lock', async () => {
    const announcement = createAnnouncementBehaviorPlugin(),
      management = definePlugin(
        {
          id: 'fixture.management',
          version: '1.0.0',
          contractVersion: 1,
          scope: 'process',
          provides: ['fixture.management'],
          requires: [],
          configSchema: { type: 'object' },
          secretFields: [],
        },
        () => undefined,
      );
    await expect(
      validateRelease(
        agent,
        [
          { id: announcement.manifest.id, version: announcement.manifest.version },
          { id: management.manifest.id, version: management.manifest.version },
        ],
        store,
        [announcement, management],
        services,
      ),
    ).rejects.toThrow('must be session scoped');
  });
});
