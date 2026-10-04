import type { LedgerPage } from '../types.ts';

export interface PageCursor {
  timestamp: string;
  id: string;
  version?: string;
}

export function pageLimit(limit = 50): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new TypeError('Page limit must be an integer from 1 to 100');
  return limit;
}

export function decodeCursor(cursor?: string): PageCursor | undefined {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!value || typeof value !== 'object') throw new Error('invalid cursor');
    const row = value as Record<string, unknown>;
    if (
      typeof row.timestamp !== 'string' ||
      !Number.isFinite(Date.parse(row.timestamp)) ||
      typeof row.id !== 'string' ||
      !row.id ||
      (row.version !== undefined && (typeof row.version !== 'string' || !row.version))
    )
      throw new Error('invalid cursor');
    return {
      timestamp: new Date(row.timestamp).toISOString(),
      id: row.id,
      ...(row.version === undefined ? {} : { version: row.version }),
    };
  } catch {
    throw new TypeError('Page cursor is invalid');
  }
}

export function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function pageFromRows<T extends { cursor: PageCursor }, R>(
  rows: T[],
  limit: number,
  map: (row: T) => R,
): LedgerPage<R> {
  const hasMore = rows.length > limit;
  const visible = hasMore ? rows.slice(0, limit) : rows;
  const last = visible.at(-1);
  return {
    items: visible.map(map),
    ...(hasMore && last ? { nextCursor: encodeCursor(last.cursor) } : {}),
  };
}
