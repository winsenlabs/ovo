import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { DraftConflictError, NodeSqliteControlStore } from '../src/index.ts';

const config = AgentConfig.parse({
  name: 'Reminder',
  mode: 'announcement',
  message: 'Hello {{name}}',
  variables: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false,
  },
});

describe('NodeSqliteControlStore', () => {
  it('persists drafts and immutable releases across a reopened database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ovo-storage-')),
      filename = join(directory, 'control.sqlite');
    try {
      let store = new NodeSqliteControlStore(filename);
      await store.ensureWorkspace('workspace-a');
      const draft = await store.createAgent('workspace-a', config);
      const updated = await store.updateAgent('workspace-a', draft.id, 1, {
        ...config,
        name: 'Updated reminder',
      });
      await expect(store.updateAgent('workspace-a', draft.id, 1, config)).rejects.toThrow(
        DraftConflictError,
      );
      const release = await store.createRelease({
        workspaceId: 'workspace-a',
        agent: updated,
        plugins: [{ id: '@winsendotai/ovo-behavior-announcement', version: '0.1.0' }],
        createdBy: 'admin',
      });
      await store.close();
      store = new NodeSqliteControlStore(filename);
      expect((await store.getAgent('workspace-a', draft.id))?.draftVersion).toBe(2);
      expect((await store.getRelease('workspace-a', release.id))?.config.name).toBe(
        'Updated reminder',
      );
      await store.updateAgent('workspace-a', draft.id, 2, { ...config, name: 'Third draft' });
      expect((await store.getRelease('workspace-a', release.id))?.config.name).toBe(
        'Updated reminder',
      );
      await store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps workspace identifiers in every resource lookup', async () => {
    const store = new NodeSqliteControlStore(':memory:');
    await store.ensureWorkspace('a');
    await store.ensureWorkspace('b');
    const agent = await store.createAgent('a', config);
    expect(await store.getAgent('b', agent.id)).toBeUndefined();
    await store.close();
  });

  it('snapshots provider bindings and atomically rejects duplicate draft releases', async () => {
    const store = new NodeSqliteControlStore(':memory:');
    await store.ensureWorkspace('workspace-a');
    const credential = await store.createCredential({
      workspaceId: 'workspace-a',
      label: 'Fixture key',
      provider: 'fixture',
      type: 'api-key',
      environment: 'test',
      backend: 'local',
      permittedAgentIds: [],
      createdBy: 'operator',
      fingerprint: 'sha256:fixture',
      secret: {
        ciphertext: Buffer.from('ciphertext'),
        nonce: Buffer.alloc(12, 1),
        authTag: Buffer.alloc(16, 2),
        backendRef: null,
      },
    });
    const binding = await store.createProviderBinding({
      workspaceId: 'workspace-a',
      label: 'Fixture provider',
      provider: 'fixture',
      environment: 'test',
      credentialId: credential.id,
      config: { model: 'v1' },
    });
    const connection = await store.createMcpConnection({
      workspaceId: 'workspace-a',
      label: 'Fixture MCP',
      endpoint: 'https://mcp.example.test',
      auth: 'none',
    });
    await store.replaceMcpDiscoveredTools('workspace-a', connection.id, [
      {
        remoteName: 'lookup',
        description: 'Lookup',
        inputSchema: { type: 'object' },
        outputSchema: null,
        schemaDigest: 'sha256:lookup',
      },
    ]);
    await store.setMcpConnectionStatus('workspace-a', connection.id, 'ready');
    const agent = await store.createAgent(
      'workspace-a',
      AgentConfig.parse({
        name: 'Context',
        mode: 'context',
        context: 'Fixture',
        providers: { inference: binding.id },
        allowedTools: ['lookup'],
        tools: [
          {
            id: 'lookup',
            description: 'Lookup',
            connector: 'mcp',
            connectionId: connection.id,
            remoteName: 'lookup',
            schemaDigest: 'sha256:lookup',
            inputSchema: { type: 'object' },
            effect: 'read',
          },
        ],
      }),
    );
    await store.upsertMcpApproval({
      workspaceId: 'workspace-a',
      agentId: agent.id,
      toolId: 'lookup',
      connectionId: connection.id,
      remoteName: 'lookup',
      schemaDigest: 'sha256:lookup',
    });
    const release = await store.createRelease({
      workspaceId: 'workspace-a',
      agent,
      plugins: [{ id: 'behavior.context', version: '1.0.0' }],
      createdBy: 'operator',
    });
    await store.updateProviderBinding('workspace-a', binding.id, {
      label: binding.label,
      provider: binding.provider,
      environment: binding.environment,
      credentialId: credential.id,
      config: { model: 'v2' },
    });
    expect(
      (await store.getRelease('workspace-a', release.id))?.providerBindings.inference?.config,
    ).toEqual({ model: 'v1' });
    await expect(
      store.createRelease({
        workspaceId: 'workspace-a',
        agent,
        plugins: [],
        createdBy: 'operator',
      }),
    ).rejects.toMatchObject({ code: 'release_conflict' });
    await store.updateMcpConnection('workspace-a', connection.id, {
      label: 'Changed MCP',
      endpoint: 'https://changed.example.test',
      auth: 'none',
    });
    expect(
      (await store.getRelease('workspace-a', release.id))?.mcpTools.lookup?.connection,
    ).toMatchObject({ endpoint: 'https://mcp.example.test', status: 'ready' });
    const nextDraft = await store.updateAgent(
      'workspace-a',
      agent.id,
      agent.draftVersion,
      AgentConfig.parse({ ...agent.config, name: 'Changed draft' }),
    );
    await expect(
      store.createRelease({
        workspaceId: 'workspace-a',
        agent: nextDraft,
        plugins: [{ id: 'behavior.context', version: '1.0.0' }],
        createdBy: 'operator',
      }),
    ).rejects.toThrow('not currently approved');
    await store.close();
  });
});
