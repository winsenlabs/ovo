import { isDeepStrictEqual } from 'node:util';
import type { OperationRecord, OperationStore } from '@winsendotai/ovo-contracts';
import type { Pool } from 'pg';
import { now, type Row, transaction } from './shared.ts';

const terminal = new Set<OperationRecord['state']>(['succeeded', 'failed', 'unknown']);

function sameIdentity(left: OperationRecord, right: OperationRecord) {
  return (
    left.id === right.id &&
    left.workspaceId === right.workspaceId &&
    left.sessionId === right.sessionId &&
    left.toolId === right.toolId &&
    isDeepStrictEqual(left.input, right.input) &&
    left.createdAt === right.createdAt
  );
}

function validTransition(from: OperationRecord['state'], to: OperationRecord['state']) {
  if (from === to) return true;
  if (terminal.has(from)) return false;
  if (from === 'intent') return to === 'running' || terminal.has(to);
  return from === 'running' && terminal.has(to);
}

export class PostgresOperationStore implements OperationStore {
  constructor(private readonly pool: Pool) {}

  async createIntent(record: OperationRecord) {
    if (record.state !== 'intent') throw new Error('Operation must begin as intent');
    const result = await this.pool.query(
      `INSERT INTO ovo_ctl_operations(workspace_id,id,record,updated_at)
       VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,id) DO NOTHING`,
      [record.workspaceId, record.id, record, now()],
    );
    return result.rowCount === 1;
  }

  async get(workspaceId: string, id: string) {
    const result = await this.pool.query<Row>(
      'SELECT record FROM ovo_ctl_operations WHERE workspace_id=$1 AND id=$2',
      [workspaceId, id],
    );
    return result.rowCount ? (result.rows[0]!.record as OperationRecord) : undefined;
  }

  async settle(record: OperationRecord) {
    await transaction(this.pool, async (client) => {
      const result = await client.query<Row>(
        `SELECT record FROM ovo_ctl_operations
         WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
        [record.workspaceId, record.id],
      );
      if (!result.rowCount) throw new Error('Operation intent not found');
      const current = result.rows[0]!.record as OperationRecord;
      if (!sameIdentity(current, record))
        throw new Error(`Operation ID ${record.id} belongs to a different request`);
      if (!validTransition(current.state, record.state))
        throw new Error(`Invalid operation transition ${current.state} -> ${record.state}`);
      await client.query(
        `UPDATE ovo_ctl_operations SET record=$1,updated_at=$2
         WHERE workspace_id=$3 AND id=$4`,
        [record, now(), record.workspaceId, record.id],
      );
    });
  }
}
