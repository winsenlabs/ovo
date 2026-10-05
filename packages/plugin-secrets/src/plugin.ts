import { Cap } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import type { CredentialStore, SecretManager } from './types.ts';
import { LocalAesGcmSecretManager } from './local.ts';
import { AwsSecretsManagerSecretManager, type AwsModule } from './aws.ts';
import { decodeMasterKey, decodePreviousMasterKeys, masterKeyRing } from './crypto.ts';
export const secretsPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-plugin-secrets',
    version: '0.1.0',
    contractVersion: 1,
    scope: 'process',
    provides: [Cap.secretManager, Cap.legacySecretResolver, Cap.secrets],
    requires: [Cap.controlStore],
    configSchema: {
      type: 'object',
      properties: {
        backend: { enum: ['local', 'encrypted-store', 'aws-secrets-manager'] },
        masterKey: { type: 'string' },
        // Comma-separated retired keys that still decrypt until `secrets:rewrap` has run.
        previousMasterKeys: { type: 'string' },
        region: { type: 'string' },
        awsPrefix: { type: 'string' },
      },
      required: ['backend'],
      additionalProperties: false,
    },
    secretFields: ['masterKey', 'previousMasterKeys'],
  },
  async (ctx, config) => {
    const store = ctx.get(Cap.controlStore) as CredentialStore;
    let service: SecretManager;
    if (config.backend === 'aws-secrets-manager') {
      const aws = (await import('@aws-sdk/client-secrets-manager')) as unknown as AwsModule;
      const client = new aws.SecretsManagerClient({
        region: typeof config.region === 'string' ? config.region : undefined,
      });
      service = new AwsSecretsManagerSecretManager(
        store,
        client,
        aws,
        typeof config.awsPrefix === 'string' ? config.awsPrefix : 'ovo',
      );
      ctx.fiber.effect(() => () => client.destroy?.(), 'close AWS Secrets Manager client');
    } else {
      const encoded =
        typeof config.masterKey === 'string'
          ? config.masterKey
          : process.env.OVO_SECRETS_MASTER_KEY;
      if (!encoded)
        throw new Error('OVO_SECRETS_MASTER_KEY is required for encrypted stored secrets');
      const previous =
        typeof config.previousMasterKeys === 'string'
          ? config.previousMasterKeys
          : process.env.OVO_SECRETS_MASTER_KEY_PREVIOUS;
      service = new LocalAesGcmSecretManager(
        store,
        masterKeyRing(decodeMasterKey(encoded), decodePreviousMasterKeys(previous)),
        config.backend === 'encrypted-store' ? 'encrypted-store' : 'local',
      );
    }
    ctx.provide(Cap.secretManager, service);
    ctx.provide(Cap.legacySecretResolver, service);
    ctx.provide(Cap.secrets, service);
  },
);

export const plugins = [secretsPlugin];
