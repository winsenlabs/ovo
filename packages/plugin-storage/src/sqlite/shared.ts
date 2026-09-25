import type { DatabaseSync } from 'node:sqlite';

export type Row = Record<string, unknown>;
export const now = () => new Date().toISOString();
export const json = (value: unknown) => JSON.stringify(value);
export const parseObject = (value: unknown) => JSON.parse(String(value)) as Record<string, unknown>;
export const parseArray = <T>(value: unknown) => JSON.parse(String(value)) as T[];
export const pageLimit = (limit = 50) => Math.max(1, Math.min(100, Math.trunc(limit)));
export const cursorValue = (cursor?: string) =>
  cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
const sensitive =
  /secret|token|password|authorization|credential|ciphertext|nonce|auth.?tag|value/i;
export function redactAudit(value: unknown, key = ''): unknown {
  if (sensitive.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redactAudit(item));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
        childKey,
        redactAudit(child, childKey),
      ]),
    );
  return value;
}
