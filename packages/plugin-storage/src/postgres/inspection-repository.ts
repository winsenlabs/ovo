import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  type AuditEntry,
  type CallRecord,
  type EvaluationRecord,
  type StoredCallEvent,
  type UsageEntry,
} from '../models.ts';
import { redactAudit } from '../sqlite/shared.ts';
import {
  decodeCursor,
  now,
  pageFromRows,
  pageLimit,
  type Row,
  toIso,
  transaction,
} from './shared.ts';

export class PostgresInspectionRepository {
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
    kind: 'live' | 'simulation';
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

  async listCalls(workspaceId: string, limit = 50, cursor?: string) {
    const size = pageLimit(limit),
      after = decodeCursor(cursor);
    const result = await this.pool.query<Row>(
      `SELECT * FROM ovo_ctl_calls WHERE workspace_id=$1
       AND ($2::timestamptz IS NULL OR (created_at,id) > ($2::timestamptz,$3::text))
       ORDER BY created_at,id LIMIT $4`,
      [workspaceId, after?.at ?? null, after?.id ?? '', size + 1],
    );
    return pageFromRows(result.rows, size, (row) => this.mapCall(row));
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

  private mapEvaluation(row: Row): EvaluationRecord {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      releaseId: String(row.release_id),
      status: String(row.status) as EvaluationRecord['status'],
      fixtures: row.fixtures as unknown[],
      createdAt: toIso(row.created_at),
      createdBy: String(row.created_by),
    };
  }

  async createEvaluation(input: {
    workspaceId: string;
    releaseId: string;
    status: 'passed' | 'failed';
    fixtures: unknown[];
    createdBy: string;
    id?: string;
  }) {
    const id = input.id ?? randomUUID();
    const result = await this.pool.query<Row>(
      `INSERT INTO ovo_ctl_evaluations
       (workspace_id,id,release_id,status,fixtures,created_at,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        input.workspaceId,
        id,
        input.releaseId,
        input.status,
        JSON.stringify(input.fixtures),
        now(),
        input.createdBy,
      ],
    );
    return this.mapEvaluation(result.rows[0]!);
  }

  async getEvaluation(workspaceId: string, id: string) {
    const result = await this.pool.query<Row>(
      'SELECT * FROM ovo_ctl_evaluations WHERE workspace_id=$1 AND id=$2',
      [workspaceId, id],
    );
    return result.rowCount ? this.mapEvaluation(result.rows[0]!) : undefined;
  }

  async listEvaluations(workspaceId: string, limit = 50, cursor?: string) {
    const size = pageLimit(limit),
      after = decodeCursor(cursor);
    const result = await this.pool.query<Row>(
      `SELECT * FROM ovo_ctl_evaluations WHERE workspace_id=$1
       AND ($2::timestamptz IS NULL OR (created_at,id) > ($2::timestamptz,$3::text))
       ORDER BY created_at,id LIMIT $4`,
      [workspaceId, after?.at ?? null, after?.id ?? '', size + 1],
    );
    return pageFromRows(result.rows, size, (row) => this.mapEvaluation(row));
  }

  private mapUsage(row: Row): UsageEntry {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      callId: String(row.call_id),
      provider: String(row.provider),
      requestId: String(row.request_id),
      quantity: String(row.quantity),
      unit: String(row.unit),
      priceCardId: String(row.price_card_id),
      priceCardVersion: String(row.price_card_version),
      amountMinor: String(row.amount_minor),
      currency: String(row.currency),
      state: String(row.state) as UsageEntry['state'],
      createdAt: toIso(row.created_at),
    };
  }

  async addUsage(input: Omit<UsageEntry, 'id' | 'createdAt'> & { id?: string }) {
    if (!/^\d+(\.\d+)?$/.test(input.quantity) || !/^\d+$/.test(input.amountMinor))
      throw new Error('Usage quantities must be nonnegative decimal strings');
    const id = input.id ?? randomUUID();
    const result = await this.pool.query<Row>(
      `INSERT INTO ovo_ctl_usage_entries
       (workspace_id,id,call_id,provider,request_id,quantity,unit,price_card_id,
        price_card_version,amount_minor,currency,state,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        input.workspaceId,
        id,
        input.callId,
        input.provider,
        input.requestId,
        input.quantity,
        input.unit,
        input.priceCardId,
        input.priceCardVersion,
        input.amountMinor,
        input.currency,
        input.state,
        now(),
      ],
    );
    return this.mapUsage(result.rows[0]!);
  }

  async listUsage(workspaceId: string, callId: string, limit = 50, cursor?: string) {
    const size = pageLimit(limit),
      after = decodeCursor(cursor);
    const result = await this.pool.query<Row>(
      `SELECT * FROM ovo_ctl_usage_entries WHERE workspace_id=$1 AND call_id=$2
       AND ($3::timestamptz IS NULL OR (created_at,id) > ($3::timestamptz,$4::text))
       ORDER BY created_at,id LIMIT $5`,
      [workspaceId, callId, after?.at ?? null, after?.id ?? '', size + 1],
    );
    return pageFromRows(result.rows, size, (row) => this.mapUsage(row));
  }

  async audit(input: {
    workspaceId: string;
    actorId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    payload?: Record<string, unknown>;
  }) {
    const entry: AuditEntry = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      payload: redactAudit(input.payload ?? {}) as Record<string, unknown>,
      createdAt: now(),
    };
    await this.pool.query(
      `INSERT INTO ovo_ctl_audit_entries
       (workspace_id,id,actor_id,action,resource_type,resource_id,payload,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        entry.workspaceId,
        entry.id,
        entry.actorId,
        entry.action,
        entry.resourceType,
        entry.resourceId,
        entry.payload,
        entry.createdAt,
      ],
    );
    return entry;
  }

  async listAudit(workspaceId: string, limit = 50, cursor?: string) {
    const size = pageLimit(limit),
      after = decodeCursor(cursor);
    const result = await this.pool.query<Row>(
      `SELECT * FROM ovo_ctl_audit_entries WHERE workspace_id=$1
       AND ($2::timestamptz IS NULL OR (created_at,id) > ($2::timestamptz,$3::text))
       ORDER BY created_at,id LIMIT $4`,
      [workspaceId, after?.at ?? null, after?.id ?? '', size + 1],
    );
    return pageFromRows(result.rows, size, (row) => ({
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      actorId: String(row.actor_id),
      action: String(row.action),
      resourceType: String(row.resource_type),
      resourceId: String(row.resource_id),
      payload: row.payload as Record<string, unknown>,
      createdAt: toIso(row.created_at),
    }));
  }
}
