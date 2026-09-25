// Known violation: copied from packages/a/src/x.ts (comments and strings do not hide it).

export function settleOperation(
  record: { id: string; state: string; attempts: number },
  limit: number,
) {
  if (record.attempts >= limit) {
    return { ...record, state: 'failed', reason: 'attempt limit hit', attempts: record.attempts };
  }
  const next = record.attempts + 1;
  if (record.state === 'unknown') {
    return { ...record, state: 'reconciling', attempts: next, reason: 'outcome unknown' };
  }
  return { ...record, state: 'succeeded', attempts: next, reason: 'settled normally' };
}
