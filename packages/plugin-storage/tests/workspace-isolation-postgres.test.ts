import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { PostgresControlStore } from '../src/index.ts';

it.skipIf(!process.env.OVO_TEST_POSTGRES_URL)(
  'keeps credential and MCP repository writes inside the selected workspace',
  async () => {
    const store = await PostgresControlStore.open(process.env.OVO_TEST_POSTGRES_URL!);
    try {
      const workspaceId = `isolation-${randomUUID()}`;
      await store.ensureWorkspace(workspaceId);
      const encryptedBlob = {
        ciphertext: Buffer.from('ciphertext'),
        nonce: Buffer.alloc(12, 1),
        authTag: Buffer.alloc(16, 2),
        backendRef: null,
      };
      const otherWorkspace = `${workspaceId}-isolation-${randomUUID()}`;
      await store.ensureWorkspace(otherWorkspace);
      const credentialInput = {
        id: randomUUID(),
        label: 'Scoped credential',
        provider: 'fixture',
        type: 'api-key' as const,
        environment: 'test',
        backend: 'encrypted-store' as const,
        permittedAgentIds: [],
        createdBy: 'test',
        fingerprint: 'sha256:original',
        secret: encryptedBlob,
      };
      const first = await store.createCredential({ ...credentialInput, workspaceId });
      const second = await store.createCredential({
        ...credentialInput,
        workspaceId: otherWorkspace,
      });
      await store.rotateCredential(workspaceId, first.id, {
        fingerprint: 'sha256:rotated',
        secret: { ...encryptedBlob, ciphertext: Buffer.from('rotated') },
      });
      expect(await store.getCredential(otherWorkspace, second.id)).toMatchObject({
        currentVersion: 1,
        fingerprint: 'sha256:original',
        status: 'active',
      });
      expect((await store.getActiveSecretBlob(otherWorkspace, second.id))?.ciphertext).toEqual(
        encryptedBlob.ciphertext,
      );
      await store.retireCredential(workspaceId, first.id);
      expect(await store.getCredential(otherWorkspace, second.id)).toMatchObject({
        status: 'active',
      });

      const connectionInput = {
        id: randomUUID(),
        label: 'Scoped MCP',
        endpoint: 'https://mcp.example.test',
        auth: 'none' as const,
      };
      const firstConnection = await store.createMcpConnection({ ...connectionInput, workspaceId });
      const secondConnection = await store.createMcpConnection({
        ...connectionInput,
        workspaceId: otherWorkspace,
      });
      const tool = {
        remoteName: 'lookup',
        description: 'Lookup',
        inputSchema: { type: 'object' },
        outputSchema: null,
        schemaDigest: 'sha256:scoped',
      };
      await store.replaceMcpDiscoveredTools(workspaceId, firstConnection.id, [tool]);
      await store.replaceMcpDiscoveredTools(otherWorkspace, secondConnection.id, [tool]);
      await store.replaceMcpDiscoveredTools(workspaceId, firstConnection.id, []);
      expect(
        (await store.getMcpDiscoveredTool(otherWorkspace, secondConnection.id, 'lookup'))
          ?.removedAt,
      ).toBeNull();
      await store.deleteMcpConnection(workspaceId, firstConnection.id);
      expect(await store.getMcpConnection(otherWorkspace, secondConnection.id)).toMatchObject({
        id: secondConnection.id,
        workspaceId: otherWorkspace,
      });
    } finally {
      await store.close();
    }
  },
);
