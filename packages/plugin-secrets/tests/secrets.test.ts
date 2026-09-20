import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeSqliteControlStore, ReferencedResourceError } from '@winsendotai/ovo-plugin-storage';
import { LocalAesGcmSecretManager } from '../src/index.ts';

describe('LocalAesGcmSecretManager', () => {
  it('encrypts at rest, rotates, survives reopen, and bounds retirement references', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ovo-secrets-')),
      filename = join(directory, 'control.sqlite'),
      key = Buffer.alloc(32, 7);
    try {
      let store = new NodeSqliteControlStore(filename);
      store.ensureWorkspace('workspace-a');
      let secrets = new LocalAesGcmSecretManager(store, key);
      const credential = await secrets.create({
        workspaceId: 'workspace-a',
        label: 'Test',
        provider: 'example',
        type: 'api-key',
        environment: 'test',
        value: 'plaintext-one',
        createdBy: 'admin',
      });
      expect(await secrets.resolve('workspace-a', credential.id)).toBe('plaintext-one');
      const rotated = await secrets.rotate('workspace-a', credential.id, 'plaintext-two');
      expect(rotated.currentVersion).toBe(2);
      expect(await secrets.resolve('workspace-a', credential.id)).toBe('plaintext-two');
      store.createProviderBinding({
        workspaceId: 'workspace-a',
        label: 'Provider',
        provider: 'example',
        environment: 'test',
        credentialId: credential.id,
        config: {},
      });
      await expect(secrets.retire('workspace-a', credential.id)).rejects.toBeInstanceOf(
        ReferencedResourceError,
      );
      store.deleteProviderBinding('workspace-a', store.listProviderBindings('workspace-a')[0]!.id);
      await secrets.retire('workspace-a', credential.id);
      await expect(secrets.resolve('workspace-a', credential.id)).rejects.toThrow(
        'Active credential not found',
      );
      const scoped = await secrets.create({
        workspaceId: 'workspace-a',
        label: 'Scoped',
        provider: 'example',
        type: 'api-key',
        environment: 'test',
        value: 'scoped-value',
        createdBy: 'admin',
        permittedAgentIds: ['agent-a'],
      });
      expect(await secrets.forAgent('agent-a').resolve('workspace-a', scoped.id)).toBe(
        'scoped-value',
      );
      await expect(secrets.forAgent('agent-b').resolve('workspace-a', scoped.id)).rejects.toThrow(
        'not permitted',
      );
      const expired = await secrets.create({
        workspaceId: 'workspace-a',
        label: 'Expired',
        provider: 'example',
        type: 'api-key',
        environment: 'test',
        value: 'expired-value',
        createdBy: 'admin',
        expiresAt: '2000-01-01T00:00:00.000Z',
      });
      await expect(secrets.resolve('workspace-a', expired.id)).rejects.toThrow(
        'Credential expired',
      );
      store.close();
      const files = [filename, `${filename}-wal`].flatMap((path) => {
        try {
          return [readFileSync(path)];
        } catch {
          return [];
        }
      });
      expect(Buffer.concat(files).includes(Buffer.from('plaintext-one'))).toBe(false);
      expect(Buffer.concat(files).includes(Buffer.from('plaintext-two'))).toBe(false);
      store = new NodeSqliteControlStore(filename);
      secrets = new LocalAesGcmSecretManager(store, key);
      expect(store.getCredential('workspace-a', credential.id)?.status).toBe('retired');
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
