import {
  LocalAesGcmSecretManager,
  masterKeyRingFromEnv,
  type CredentialStore,
} from '@winsendotai/ovo-plugin-secrets';

/**
 * The worker's credential reader. It decrypts with OVO_SECRETS_MASTER_KEY and any
 * OVO_SECRETS_MASTER_KEY_PREVIOUS, so calls keep resolving credentials between a master key
 * rotation and the end of the rewrap (OPS-1).
 */
export function workerSecretManager(
  store: CredentialStore,
  env: Readonly<Record<string, string | undefined>> = process.env,
): LocalAesGcmSecretManager {
  return new LocalAesGcmSecretManager(store, masterKeyRingFromEnv(env), 'encrypted-store');
}
