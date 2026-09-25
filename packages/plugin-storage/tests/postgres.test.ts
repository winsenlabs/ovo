import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentConfig, type OperationRecord } from '@winsendotai/ovo-contracts';
import { DraftConflictError, PostgresControlStore, ReferencedResourceError } from '../src/index.ts';

const databaseUrl = process.env.OVO_TEST_POSTGRES_URL;
const integration = databaseUrl ? describe : describe.skip;

const announcement = (name: string) =>
  AgentConfig.parse({ name, mode: 'announcement', message: `Hello from ${name}` });

const encryptedBlob = {
  ciphertext: Buffer.from('ciphertext'),
  nonce: Buffer.alloc(12, 1),
  authTag: Buffer.alloc(16, 2),
  backendRef: null,
};

integration('PostgresControlStore', () => {
  let store: PostgresControlStore;
  const workspaceId = `storage-${randomUUID()}`;

  beforeAll(async () => {
    const cleanup = new pg.Pool({ connectionString: databaseUrl });
    const tables = await cleanup.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname=current_schema() AND tablename LIKE 'ovo_ctl_%'`,
    );
    for (const { tablename } of tables.rows) {
      if (!/^ovo_ctl_[a-z_]+$/.test(tablename)) throw new Error('Unexpected table prefix');
      await cleanup.query(`DROP TABLE ${tablename} CASCADE`);
    }
    await cleanup.query('DROP TABLE IF EXISTS ovo_control_schema_migrations CASCADE');
    await cleanup.end();
    store = await PostgresControlStore.open(databaseUrl!);
    await store.ensureWorkspace(workspaceId, 'Single self-hosted organization');
  });

  afterAll(async () => {
    await store?.close();
  });

  it('runs distinct versioned migrations idempotently', async () => {
    const second = await PostgresControlStore.open(databaseUrl!);
    await second.close();
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const versions = await pool.query<{ version: number }>(
      'SELECT version FROM ovo_control_schema_migrations ORDER BY version',
    );
    const unrelated = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pg_tables
       WHERE schemaname=current_schema() AND tablename LIKE 'ovo_orchestration_%'`,
    );
    await pool.end();
    expect(versions.rows.map((row) => row.version)).toEqual([1, 2, 3, 4, 5]);
    expect(Number(unrelated.rows[0]!.count)).toBeGreaterThanOrEqual(0);
  });

  it('bounds cursor pages and isolates internal workspace lookups', async () => {
    const otherWorkspace = `${workspaceId}-other`;
    await store.ensureWorkspace(otherWorkspace);
    const created = await Promise.all([
      store.createAgent(workspaceId, announcement('Page A')),
      store.createAgent(workspaceId, announcement('Page B')),
      store.createAgent(workspaceId, announcement('Page C')),
    ]);
    const first = await store.listAgents(workspaceId, 2);
    const second = await store.listAgents(workspaceId, 2, first.nextCursor!);
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(3);
    expect(await store.getAgent(otherWorkspace, created[0]!.id)).toBeUndefined();
    await expect(store.listAgents(workspaceId, 10, 'not-a-cursor')).rejects.toMatchObject({
      code: 'invalid_cursor',
    });
  });

  it('uses atomic optimistic drafts and permits only one release per draft', async () => {
    const agent = await store.createAgent(workspaceId, announcement('Optimistic'));
    const attempts = await Promise.allSettled([
      store.updateAgent(workspaceId, agent.id, 1, announcement('Winner A')),
      store.updateAgent(workspaceId, agent.id, 1, announcement('Winner B')),
    ]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      attempts.some(
        (result) => result.status === 'rejected' && result.reason instanceof DraftConflictError,
      ),
    ).toBe(true);
    const current = (await store.getAgent(workspaceId, agent.id))!;
    const releases = await Promise.allSettled([
      store.createRelease({
        id: randomUUID(),
        workspaceId,
        agent: current,
        plugins: [{ id: 'behavior.fixture', version: '1.0.0' }],
        createdBy: 'operator',
      }),
      store.createRelease({
        id: randomUUID(),
        workspaceId,
        agent: current,
        plugins: [{ id: 'behavior.fixture', version: '1.0.0' }],
        createdBy: 'operator',
      }),
    ]);
    expect(releases.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(releases.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await store.updateAgent(workspaceId, agent.id, current.draftVersion, announcement('Later'));
    await expect(
      store.createRelease({
        workspaceId,
        agent: current,
        plugins: [],
        createdBy: 'operator',
      }),
    ).rejects.toBeInstanceOf(DraftConflictError);
  });

  it('rolls back invalid credentials and manages scoped secret references', async () => {
    const invalidId = randomUUID();
    await expect(
      store.createCredential({
        id: invalidId,
        workspaceId,
        label: 'Invalid',
        provider: 'fixture',
        type: 'api-key',
        environment: 'production',
        backend: 'encrypted-store',
        permittedAgentIds: [],
        createdBy: 'operator',
        fingerprint: 'sha256:invalid',
        secret: { ciphertext: null, nonce: null, authTag: null, backendRef: null },
      }),
    ).rejects.toBeTruthy();
    expect(await store.getCredential(workspaceId, invalidId)).toBeUndefined();

    const credential = await store.createCredential({
      workspaceId,
      label: 'Inference key',
      provider: 'fixture',
      type: 'api-key',
      environment: 'production',
      backend: 'encrypted-store',
      permittedAgentIds: [],
      createdBy: 'operator',
      fingerprint: 'sha256:first',
      secret: encryptedBlob,
    });
    const rotated = await store.rotateCredential(workspaceId, credential.id, {
      fingerprint: 'sha256:second',
      secret: { ...encryptedBlob, ciphertext: Buffer.from('rotated') },
    });
    expect(rotated.currentVersion).toBe(2);
    expect((await store.getActiveSecretBlob(workspaceId, credential.id))?.ciphertext).toEqual(
      Buffer.from('rotated'),
    );
    const binding = await store.createProviderBinding({
      workspaceId,
      label: 'Inference',
      provider: 'fixture',
      environment: 'production',
      credentialId: credential.id,
      config: { model: 'fixture-v1' },
    });
    await expect(store.retireCredential(workspaceId, credential.id)).rejects.toBeInstanceOf(
      ReferencedResourceError,
    );
    const references = await store.credentialReferences(workspaceId, credential.id, 1);
    expect(references.providerBindings).toEqual({ total: 1, ids: [binding.id] });
  });

  it('snapshots provider bindings into an immutable release transaction', async () => {
    const credentials = await store.listCredentials(workspaceId, 10);
    const bindings = await store.listProviderBindings(workspaceId, 10);
    const binding = bindings.items[0]!;
    const agent = await store.createAgent(
      workspaceId,
      AgentConfig.parse({
        name: 'Context agent',
        mode: 'context',
        context: 'Known facts',
        providers: { inference: binding.id },
      }),
    );
    const release = await store.createRelease({
      workspaceId,
      agent,
      plugins: [{ id: 'behavior.context', version: '1.0.0' }],
      createdBy: 'operator',
    });
    await store.updateProviderBinding(workspaceId, binding.id, {
      label: binding.label,
      provider: binding.provider,
      environment: binding.environment,
      credentialId: credentials.items[0]!.id,
      config: { model: 'fixture-v2' },
    });
    expect(release.providerBindings.inference?.config).toEqual({ model: 'fixture-v1' });
    expect((await store.getRelease(workspaceId, release.id))?.providerBindings).toEqual(
      release.providerBindings,
    );
  });

  it('persists MCP discovery and approvals with exact scoped identities', async () => {
    const connection = await store.createMcpConnection({
      workspaceId,
      label: 'Internal connector',
      endpoint: 'https://mcp.example.test',
      auth: 'none',
    });
    await store.setMcpConnectionStatus(workspaceId, connection.id, 'ready');
    const [tool] = await store.replaceMcpDiscoveredTools(workspaceId, connection.id, [
      {
        remoteName: 'lookup',
        description: 'Lookup',
        inputSchema: { type: 'object' },
        outputSchema: null,
        schemaDigest: 'sha256:lookup',
      },
    ]);
    const agent = await store.createAgent(
      workspaceId,
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
    const approval = await store.upsertMcpApproval({
      workspaceId,
      agentId: agent.id,
      toolId: 'lookup',
      connectionId: connection.id,
      remoteName: tool!.remoteName,
      schemaDigest: tool!.schemaDigest,
    });
    expect(
      (await store.getMcpDiscoveredTool(workspaceId, connection.id, 'lookup'))?.schemaDigest,
    ).toBe('sha256:lookup');
    expect((await store.listMcpApprovals(workspaceId, agent.id, 1)).items).toEqual([approval]);
    const release = await store.createRelease({
      workspaceId,
      agent,
      plugins: [{ id: 'behavior.announcement', version: '1.0.0' }],
      createdBy: 'operator',
    });
    await store.updateMcpConnection(workspaceId, connection.id, {
      label: 'Changed connector',
      endpoint: 'https://changed.example.test',
      auth: 'none',
    });
    expect(release.mcpTools.lookup?.connection).toMatchObject({
      endpoint: 'https://mcp.example.test',
      status: 'ready',
    });
    expect((await store.getRelease(workspaceId, release.id))?.mcpTools).toEqual(release.mcpTools);
    const nextDraft = await store.updateAgent(
      workspaceId,
      agent.id,
      agent.draftVersion,
      AgentConfig.parse({ ...agent.config, name: 'Changed MCP draft' }),
    );
    await expect(
      store.createRelease({
        workspaceId,
        agent: nextDraft,
        plugins: [{ id: 'behavior.announcement', version: '1.0.0' }],
        createdBy: 'operator',
      }),
    ).rejects.toThrow('not currently approved');
    await expect(store.deleteMcpConnection(workspaceId, connection.id)).rejects.toBeInstanceOf(
      ReferencedResourceError,
    );
  });

  it('serializes call events and persists evaluations, usage and redacted audit pages', async () => {
    const agent = await store.createAgent(workspaceId, announcement('Inspection'));
    const release = await store.createRelease({
      workspaceId,
      agent,
      plugins: [{ id: 'behavior.announcement', version: '1.0.0' }],
      createdBy: 'operator',
    });
    const call = await store.createCall({
      workspaceId,
      releaseId: release.id,
      kind: 'simulation',
      status: 'running',
    });
    const events = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.appendCallEvent(workspaceId, call.id, 'fixture', { index }),
      ),
    );
    expect(events.map((event) => event.sequence).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 10 }, (_, index) => index + 1),
    );
    expect((await store.listCallEvents(workspaceId, call.id, 4)).items).toHaveLength(4);
    const evaluation = await store.createEvaluation({
      workspaceId,
      releaseId: release.id,
      status: 'passed',
      fixtures: [{ passed: true }],
      createdBy: 'operator',
    });
    expect((await store.getEvaluation(workspaceId, evaluation.id))?.status).toBe('passed');
    const usage = await store.addUsage({
      workspaceId,
      callId: call.id,
      provider: 'fixture',
      requestId: 'request-1',
      quantity: '10.5',
      unit: 'tokens',
      priceCardId: 'card',
      priceCardVersion: '1',
      amountMinor: '42',
      currency: 'INR',
      state: 'reconciled',
    });
    expect((await store.listUsage(workspaceId, call.id, 1)).items).toEqual([usage]);
    await store.audit({
      workspaceId,
      actorId: 'operator',
      action: 'fixture',
      resourceType: 'call',
      resourceId: call.id,
      payload: { authorization: 'Bearer secret', nested: { token: 'secret' } },
    });
    expect((await store.listAudit(workspaceId, 1)).items[0]!.payload).toEqual({
      authorization: '[REDACTED]',
      nested: { token: '[REDACTED]' },
    });
  });

  it('keeps durable operation intent identity immutable under races', async () => {
    const record: OperationRecord = {
      id: randomUUID(),
      workspaceId,
      sessionId: 'session-a',
      toolId: 'tool-a',
      input: { account: 1 },
      state: 'intent',
      createdAt: new Date().toISOString(),
    };
    const created = await Promise.all(
      Array.from({ length: 10 }, () => store.operationStore.createIntent(record)),
    );
    expect(created.filter(Boolean)).toHaveLength(1);
    await expect(
      store.operationStore.settle({ ...record, sessionId: 'different', state: 'failed' }),
    ).rejects.toThrow('different request');
    await store.operationStore.settle({ ...record, state: 'running' });
    await store.operationStore.settle({ ...record, state: 'succeeded', result: { ok: true } });
    expect((await store.operationStore.get(workspaceId, record.id))?.state).toBe('succeeded');
    await expect(
      store.operationStore.settle({ ...record, state: 'failed', error: 'rewrite' }),
    ).rejects.toThrow('Invalid operation transition');
  });
});
