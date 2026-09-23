import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { CallListFilters } from '../control-store.ts';
import type { CallRecord, StoredCallEvent } from '../models.ts';
import {
  decodeCursor,
  now,
  pageFromRows,
  pageLimit,
  type Row,
  toIso,
  transaction,
} from './shared.ts';

export class PostgresCallsRepository {
  constructor(private readonly pool: Pool) {}
  private mapCall(row: Row): CallRecord {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      releaseId: String(row.release_id),
      kind: String(row.kind) as CallRecord['kind'],
      status: String(row.status),
      createdAt: toIso(row.created_at),
      completedAt: row.completed_at === null ? null : toIso(row.completed_at),
    };
  }

  async createCall(input: {
    workspaceId: string;
    releaseId: string;
    kind: CallRecord['kind'];
    status: string;
    id?: string;
  }) {
    const id = input.id ?? randomUUID(),
      at = now();
    const result = await this.pool.query<Row>(
      `INSERT INTO ovo_ctl_calls(workspace_id,id,release_id,kind,status,created_at)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [input.workspaceId, id, input.releaseId, input.kind, input.status, at],
    );
    return this.mapCall(result.rows[0]!);
  }

  async getCall(workspaceId: string, id: string) {
    const result = await this.pool.query<Row>(
      'SELECT * FROM ovo_ctl_calls WHERE workspace_id=$1 AND id=$2',
      [workspaceId, id],
    );
    return result.rowCount ? this.mapCall(result.rows[0]!) : undefined;
  }

  async listCalls(workspaceId: string, limit = 50, cursor?: string, filters: CallListFilters = {}) {
    const size = pageLimit(limit),
      after = decodeCursor(cursor),
      ascending = filters.order === 'asc';
    const result = await this.pool.query<Row>(
      `SELECT c.*, to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
       FROM ovo_ctl_calls c
       JOIN ovo_ctl_releases r ON r.workspace_id=c.workspace_id AND r.id=c.release_id
       WHERE c.workspace_id=$1
       AND ($2::timestamptz IS NULL OR (c.created_at,c.id) ${ascending ? '>' : '<'} ($2::timestamptz,$3::text))
       AND ($4::text IS NULL OR r.agent_id=$4)
       AND ($5::text IS NULL OR c.kind=$5)
       AND ($6::text IS NULL OR c.status=$6)
       AND ($7::text IS NULL OR r.selections @> jsonb_build_object('engine',jsonb_build_object('pluginId',$7::text)))
       AND ($8::text IS NULL OR r.selections @> jsonb_build_object('carrier',jsonb_build_object('pluginId',$8::text)))
       ORDER BY c.created_at ${ascending ? 'ASC' : 'DESC'},c.id ${ascending ? 'ASC' : 'DESC'} LIMIT $9`,
      [
        workspaceId,
        after?.at ?? null,
        after?.id ?? '',
        filters.agentId ?? null,
        filters.kind ?? null,
        filters.status ?? null,
        filters.engine ?? null,
        filters.carrier ?? null,
        size + 1,
      ],
    );
    return pageFromRows(
      result.rows,
      size,
      (row) => this.mapCall(row),
      (row) => ({ at: String(row.cursor_at), id: String(row.id) }),
    );
  }

  async finishCall(workspaceId: string, id: string, status: string) {
    const result = await this.pool.query<Row>(
      `UPDATE ovo_ctl_calls SET status=$1,completed_at=$2
       WHERE workspace_id=$3 AND id=$4 RETURNING *`,
      [status, now(), workspaceId, id],
    );
    if (!result.rowCount) throw new Error('Call not found');
    return this.mapCall(result.rows[0]!);
  }

  async appendCallEvent(
    workspaceId: string,
    callId: string,
    type: string,
    payload: Record<string, unknown>,
    epoch = 0,
  ) {
    return transaction(this.pool, async (client) => {
      const call = await client.query(
        'SELECT 1 FROM ovo_ctl_calls WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [workspaceId, callId],
      );
      if (!call.rowCount) throw new Error('Call not found');
      const sequenceResult = await client.query<{ sequence: number }>(
        `SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM ovo_ctl_call_events
         WHERE workspace_id=$1 AND call_id=$2`,
        [workspaceId, callId],
      );
      const event: StoredCallEvent = {
        id: randomUUID(),
        callId,
        sequence: Number(sequenceResult.rows[0]!.sequence),
        at: now(),
        type,
        epoch,
        payload,
      };
      await client.query(
        `INSERT INTO ovo_ctl_call_events
         (workspace_id,call_id,id,sequence,at,type,epoch,payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [workspaceId, callId, event.id, event.sequence, event.at, type, epoch, payload],
      );
      return event;
    });
  }

  async listCallEvents(workspaceId: string, callId: string, limit = 50, cursor?: string) {
    const size = pageLimit(limit),
      after = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
    if (cursor && !/^\d+$/.test(cursor))
      throw Object.assign(new Error('Invalid pagination cursor'), {
        statusCode: 400,
        code: 'invalid_cursor',
      });
    const result = await this.pool.query<Row>(
      `SELECT e.* FROM ovo_ctl_call_events e
       JOIN ovo_ctl_calls c ON c.workspace_id=e.workspace_id AND c.id=e.call_id
       WHERE e.workspace_id=$1 AND e.call_id=$2 AND e.sequence>$3
       ORDER BY e.sequence LIMIT $4`,
      [workspaceId, callId, after, size + 1],
    );
    const more = result.rows.length > size;
    if (more) result.rows.pop();
    return {
      items: result.rows.map((row) => ({
        id: String(row.id),
        callId: String(row.call_id),
        sequence: Number(row.sequence),
        at: toIso(row.at),
        type: String(row.type),
        epoch: Number(row.epoch),
        payload: row.payload as Record<string, unknown>,
      })),
      nextCursor: more ? String(result.rows.at(-1)!.sequence) : null,
    };
  }
}
