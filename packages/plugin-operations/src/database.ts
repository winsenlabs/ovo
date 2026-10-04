import type { Pool, PoolClient } from 'pg';
import { transaction as sharedTransaction } from '@winsendotai/ovo-plugin-kit/postgres-transaction';

export function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return sharedTransaction<PoolClient, T>(pool, work);
}

export function boundedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  return Math.min(limit, 100);
}
