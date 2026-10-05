import { createHash } from 'node:crypto';
export function fingerprint(value: string) {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}
export function decodeMasterKey(encoded: string, name = 'OVO_SECRETS_MASTER_KEY'): Buffer {
  const key = /^[a-f\d]{64}$/i.test(encoded)
    ? Buffer.from(encoded, 'hex')
    : Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error(`${name} must decode to exactly 32 bytes`);
  return key;
}

export interface MasterKey {
  /** Non-secret, stable identifier stored beside every ciphertext the key produces. */
  id: string;
  key: Buffer;
}
/** The primary key encrypts; previous keys only decrypt until `secrets:rewrap` retires them. */
export interface MasterKeyRing {
  primary: MasterKey;
  previous: readonly MasterKey[];
}

export function masterKeyId(key: Uint8Array): string {
  return createHash('sha256')
    .update('ovo-secrets-master-key-id\0')
    .update(key)
    .digest('hex')
    .slice(0, 16);
}

export function masterKeyRing(
  primary: Uint8Array,
  previous: readonly Uint8Array[] = [],
): MasterKeyRing {
  const entry = (key: Uint8Array): MasterKey => {
    if (key.length !== 32) throw new Error('AES-256-GCM key must be 32 bytes');
    return { id: masterKeyId(key), key: Buffer.from(key) };
  };
  const ring = { primary: entry(primary), previous: [] as MasterKey[] };
  for (const key of previous.map(entry))
    if (key.id !== ring.primary.id && !ring.previous.some((item) => item.id === key.id))
      ring.previous.push(key);
  return ring;
}

/** Comma-separated, newest first; blank entries are ignored so an empty variable means none. */
export function decodePreviousMasterKeys(encoded: string | undefined): Buffer[] {
  return (encoded ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => decodeMasterKey(item, 'OVO_SECRETS_MASTER_KEY_PREVIOUS'));
}

export function masterKeyRingFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): MasterKeyRing {
  const encoded = env.OVO_SECRETS_MASTER_KEY;
  if (!encoded) throw new Error('OVO_SECRETS_MASTER_KEY is required for encrypted stored secrets');
  return masterKeyRing(
    decodeMasterKey(encoded),
    decodePreviousMasterKeys(env.OVO_SECRETS_MASTER_KEY_PREVIOUS),
  );
}
