import { createHash } from 'node:crypto';
export function fingerprint(value: string) {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}
export function decodeMasterKey(encoded: string): Buffer {
  const key = /^[a-f\d]{64}$/i.test(encoded)
    ? Buffer.from(encoded, 'hex')
    : Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('OVO_SECRETS_MASTER_KEY must decode to exactly 32 bytes');
  return key;
}
