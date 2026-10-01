import { expect, it, vi } from 'vitest';
import { transaction } from '../src/postgres-transaction.ts';

it('commits a completed unit of work and releases its client', async () => {
  const client = { query: vi.fn(async (_sql: string) => undefined), release: vi.fn() };
  const pool = { connect: vi.fn(async () => client) };
  await expect(transaction(pool, async () => 17)).resolves.toBe(17);
  expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT']);
  expect(client.release).toHaveBeenCalledTimes(1);
});

it('rolls back a rejected unit of work and releases its client', async () => {
  const client = { query: vi.fn(async (_sql: string) => undefined), release: vi.fn() };
  const pool = { connect: vi.fn(async () => client) };
  await expect(
    transaction(pool, async () => {
      throw new Error('write refused');
    }),
  ).rejects.toThrow('write refused');
  expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK']);
  expect(client.release).toHaveBeenCalledTimes(1);
});
