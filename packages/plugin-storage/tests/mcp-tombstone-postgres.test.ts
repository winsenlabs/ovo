import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { expect, it } from 'vitest';
import { PostgresControlStore } from '../src/index.ts';

const url = process.env.OVO_TEST_POSTGRES_URL;

(url ? it : it.skip)('does not publish an MCP tool tombstoned after approval', async () => {
  const schema = `mcp_tombstone_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: url! });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const store = await PostgresControlStore.open({
    connectionString: url!,
    options: `-c search_path=${schema}`,
  });
  try {
    await store.ensureWorkspace('workspace');
    const connection = await store.createMcpConnection({
      workspaceId: 'workspace',
      label: 'MCP',
      endpoint: 'https://mcp.example.test',
      auth: 'none',
    });
    await store.setMcpConnectionStatus('workspace', connection.id, 'ready');
    await store.replaceMcpDiscoveredTools('workspace', connection.id, [
      {
        remoteName: 'lookup',
        description: 'Lookup',
        inputSchema: { type: 'object' },
        outputSchema: null,
        schemaDigest: 'sha256:lookup',
      },
    ]);
    const agent = await store.createAgent(
      'workspace',
      AgentConfig.parse({
        name: 'MCP',
        mode: 'announcement',
        message: 'Fixture',
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
      workspaceId: 'workspace',
      agentId: agent.id,
      toolId: 'lookup',
      connectionId: connection.id,
      remoteName: 'lookup',
      schemaDigest: 'sha256:lookup',
    });
    await store.replaceMcpDiscoveredTools('workspace', connection.id, []);
    await expect(
      store.createRelease({
        workspaceId: 'workspace',
        agent,
        plugins: [{ id: 'behavior.announcement', version: '1.0.0' }],
        createdBy: 'operator',
      }),
    ).rejects.toThrow('not currently approved');
    expect((await store.listReleases('workspace', agent.id, 50)).items).toEqual([]);
  } finally {
    await store.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
