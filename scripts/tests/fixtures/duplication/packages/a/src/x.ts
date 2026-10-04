// Known violation: the same function as packages/b/src/y.ts.
import { unrelated } from './unrelated.ts';

export function settleOperation(
  record: { id: string; state: string; attempts: number },
  limit: number,
) {
  if (record.attempts >= limit) {
    return { ...record, state: 'failed', reason: 'too many attempts', attempts: record.attempts };
  }
  const next = record.attempts + 1;
  if (record.state === 'unknown') {
    return { ...record, state: 'reconciling', attempts: next, reason: 'outcome unknown' };
  }
  return { ...record, state: 'succeeded', attempts: next, reason: 'settled normally' };
}

export const tag = unrelated;
