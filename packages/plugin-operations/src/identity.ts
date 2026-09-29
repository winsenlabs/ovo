import { createHash } from 'node:crypto';
import { canonicalJson } from '@winsendotai/ovo-contracts';

export function inputDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
