import { createHash } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

export type Queryable = Pick<Pool | PoolClient, 'query'>;
export type Row = QueryResultRow & Record<string, unknown>;

export const now = () => new Date().toISOString();
export const pageLimit = (limit = 50) => Math.max(1, Math.min(100, Math.trunc(limit)));

export interface PageCursor {
  at: string;
  id: string;
}

export function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(cursor?: string): PageCursor | undefined {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      !value ||
      typeof value !== 'object' ||
      typeof (value as PageCursor).at !== 'string' ||
      typeof (value as PageCursor).id !== 'string'
    )
      throw new Error('invalid');
    return value as PageCursor;
  } catch {
    throw Object.assign(new Error('Invalid pagination cursor'), {
      statusCode: 400,
      code: 'invalid_cursor',
    });
  }
}

export function pageFromRows<T>(
  rows: Row[],
  limit: number,
  map: (row: Row) => T,
  cursor: (row: Row) => PageCursor = (row) => ({
    at: toIso(row.created_at),
    id: String(row.id),
  }),
) {
  const more = rows.length > limit;
  if (more) rows.pop();
  return {
    items: rows.map(map),
    nextCursor: more && rows.length ? encodeCursor(cursor(rows.at(-1)!)) : null,
  };
}

export const toIso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();

export async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function migrationChecksum(sql: string) {
  return createHash('sha256').update(sql).digest('hex');
}

export function isUniqueViolation(error: unknown) {
  return (error as { code?: string } | undefined)?.code === '23505';
}
