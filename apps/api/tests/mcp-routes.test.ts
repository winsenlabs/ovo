import { expect, it, vi } from 'vitest';
import type { OperationRecord, OperationStore, ToolDefinition } from '@winsendotai/ovo-contracts';
import {
  createExecutionService,
  ConnectorPolicyError,
} from '../../../packages/plugin-tools/src/index.ts';
import { createHttpConnector } from '../../../packages/plugin-tools-http/src/index.ts';
import { selectedSpeechFixture, selectedSpeechVoice } from './selected-speech-fixture.ts';

const definition: ToolDefinition = {
  id: 'write',
  description: 'Write',
  connector: 'http',
  effect: 'write',
  confirmation: true,
  inputSchema: { type: 'object' },
  timeoutMs: 1_000,
  processing: { initial: 'Working.', failure: 'Failed.', maxProgress: 0, progressAfterMs: 500 },
};

it.each(['private DNS', 'DNS failure', 'missing binding', 'missing credential'])(
  'records %s as failed before dispatch for a write',
  async (reason) => {
    const fetch = vi.fn(async () => new Response('{}'));
    const connector = createHttpConnector(
      reason === 'missing binding'
        ? []
        : [
            {
              toolId: 'write',
              workspaceId: 'w',
              endpoint: 'https://tools.example.test/write',
              method: 'POST',
              ...(reason === 'missing credential'
                ? { auth: { type: 'bearer' as const, credentialId: 'missing' } }
                : {}),
            },
          ],
      {
        fetch,
        lookup: async () => {
          if (reason === 'DNS failure') throw new Error('ENOTFOUND');
          return [{ address: '10.0.0.1', family: 4 }];
        },
        secrets: {
          async resolve() {
            throw new Error('revoked credential');
          },
        },
      },
    );
    let saved: OperationRecord | undefined;
    const store: OperationStore = {
      async createIntent(record) {
        saved = record;
        return true;
      },
      async get() {
        return saved;
      },
      async settle(record) {
        saved = record;
      },
    };
    const execution = createExecutionService(
      { tools: [definition], allowedTools: ['write'] },
      {
        store,
        connectors: { http: connector },
        speech: {
          async speak(text) {
            return { id: 'r', text, epoch: 0, state: 'completed', evidence: 'simulated' };
          },
          async interrupt() {},
        },
      },
    );
    const record = await execution.execute({
      id: 'op',
      workspaceId: 'w',
      sessionId: 's',
      toolId: 'write',
      input: {},
      confirmed: true,
    });
    expect(record.state).toBe('failed');
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      connector.invoke(
        definition,
        {},
        { operationId: 'another', workspaceId: 'w', signal: new AbortController().signal },
      ),
    ).rejects.toBeInstanceOf(ConnectorPolicyError);
  },
);

it('presents removed MCP tools and refuses reapproval through the management API', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { NodeSqliteControlStore } = await import('../../../packages/plugin-storage/src/index.ts');
  const { AgentConfig } = await import('@winsendotai/ovo-contracts');
  const { buildManagementApi } = await import('../src/server.ts');
  const directory = mkdtempSync(join(tmpdir(), 'ovo-m1-mcp-api-'));
  const filename = join(directory, 'control.sqlite');
  const store = new NodeSqliteControlStore(filename);
  let dispose: (() => Promise<void>) | undefined;
  try {
    await store.ensureWorkspace('workspace');
    const connection = await store.createMcpConnection({
      workspaceId: 'workspace',
      label: 'Remote',
      endpoint: 'https://mcp.example.test/mcp',
      auth: 'none',
    });
    const schemaDigest = 'fixture-digest';
    const config = AgentConfig.parse({
      name: 'MCP',
      mode: 'announcement',
      message: 'Hello',
      voice: selectedSpeechVoice,
      tools: [
        {
          id: 'lookup',
          description: 'Lookup',
          connector: 'mcp',
          connectionId: connection.id,
          remoteName: 'lookup',
          schemaDigest,
          inputSchema: {},
          effect: 'read',
        },
      ],
      allowedTools: ['lookup'],
    });
    const agent = await store.createAgent('workspace', config);
    const laterAgent = await store.createAgent('workspace', config);
    await store.replaceMcpDiscoveredTools('workspace', connection.id, [
      { remoteName: 'lookup', description: '', inputSchema: {}, outputSchema: null, schemaDigest },
    ]);
    await store.setMcpConnectionStatus('workspace', connection.id, 'ready');
    await store.upsertMcpApproval({
      workspaceId: 'workspace',
      agentId: agent.id,
      toolId: 'lookup',
      connectionId: connection.id,
      remoteName: 'lookup',
      schemaDigest,
    });
    await store.upsertMcpApproval({
      workspaceId: 'workspace',
      agentId: laterAgent.id,
      toolId: 'lookup',
      connectionId: connection.id,
      remoteName: 'lookup',
      schemaDigest,
    });
    const { app, composition } = await buildManagementApi({
      databaseFile: filename,
      secretsMasterKey: Buffer.alloc(32, 3).toString('base64'),
      sessionSecret: 'fixture-session-key',
      pluginCatalog: [selectedSpeechFixture],
      identities: [
        {
          id: 'admin',
          label: 'Admin',
          token: 'token',
          defaultWorkspaceId: 'workspace',
          workspaces: { workspace: 'admin' },
        },
      ],
    });
    dispose = () => composition.dispose();
    const headers = { authorization: 'Bearer token' };
    const accepted = await app.inject({
      method: 'POST',
      url: `/v1/agents/${agent.id}/releases`,
      headers,
      payload: {},
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    await store.replaceMcpDiscoveredTools('workspace', connection.id, []);
    const rejected = await app.inject({
      method: 'POST',
      url: `/v1/agents/${laterAgent.id}/releases`,
      headers,
      payload: {},
    });
    expect(rejected.statusCode, rejected.body).toBe(422);
    expect(rejected.json().blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'mcp_tool_removed' })]),
    );
    await expect(
      store.createRelease({
        workspaceId: 'workspace',
        agent: laterAgent,
        plugins: accepted.json().plugins,
        selections: accepted.json().selections,
        createdBy: 'admin',
      }),
    ).rejects.toThrow('MCP tool lookup is not currently approved');
    expect((await store.listReleases('workspace', laterAgent.id, 50)).items).toEqual([]);
    const listed = await app.inject({
      method: 'GET',
      url: `/v1/mcp-connections/${connection.id}/tools`,
      headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toEqual([
      expect.objectContaining({ remoteName: 'lookup', removedAt: expect.any(String) }),
    ]);
    const approval = await app.inject({
      method: 'PUT',
      url: `/v1/agents/${agent.id}/mcp-tools/lookup`,
      headers,
      payload: { connectionId: connection.id, remoteName: 'lookup', schemaDigest },
    });
    expect(approval.statusCode).toBe(422);
    expect(approval.json().error.code).toBe('mcp_approval_invalid');
  } finally {
    await dispose?.();
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
