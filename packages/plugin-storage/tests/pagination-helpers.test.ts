import { expect, it } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { NodeSqliteControlStore } from '../src/index.ts';

const config = (name: string) => AgentConfig.parse({ name, mode: 'announcement', message: name });

it('keeps SQLite agent and credential cursor pages scoped to their workspace', async () => {
  const store = new NodeSqliteControlStore(':memory:');
  try {
    await store.ensureWorkspace('a');
    await store.ensureWorkspace('b');
    const agents = [
      await store.createAgent('a', config('one'), 'agent-one'),
      await store.createAgent('b', config('other'), 'agent-other'),
      await store.createAgent('a', config('two'), 'agent-two'),
    ];
    const firstAgentPage = await store.listAgents('a', 1);
    const secondAgentPage = await store.listAgents('a', 1, firstAgentPage.nextCursor!);
    expect([...firstAgentPage.items, ...secondAgentPage.items].map((row) => row.id)).toEqual([
      agents[0]!.id,
      agents[2]!.id,
    ]);
    expect(secondAgentPage.nextCursor).toBeNull();

    for (const [workspaceId, id] of [
      ['a', 'credential-one'],
      ['b', 'credential-other'],
      ['a', 'credential-two'],
    ])
      await store.createCredential({
        workspaceId: workspaceId!,
        id: id!,
        label: id!,
        provider: 'fixture',
        type: 'api-key',
        environment: 'test',
        backend: 'local',
        permittedAgentIds: [],
        createdBy: 'test',
        fingerprint: `fingerprint:${id}`,
        secret: {
          ciphertext: Buffer.from(id!),
          nonce: Buffer.alloc(12),
          authTag: Buffer.alloc(16),
          backendRef: null,
        },
      });
    const firstCredentialPage = await store.listCredentials('a', 1);
    const secondCredentialPage = await store.listCredentials(
      'a',
      1,
      firstCredentialPage.nextCursor!,
    );
    expect(
      [...firstCredentialPage.items, ...secondCredentialPage.items].map((row) => row.id),
    ).toEqual(['credential-one', 'credential-two']);
    expect(secondCredentialPage.nextCursor).toBeNull();
  } finally {
    await store.close();
  }
});
