import { createHash } from 'node:crypto';
import { canonicalJson } from '@winsendotai/ovo-contracts';

export { canonicalJson };

/** Code-unit JSON order also defines persisted operation and schema identities. */
export function schemaDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
