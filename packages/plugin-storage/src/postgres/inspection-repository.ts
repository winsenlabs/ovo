import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { type AuditEntry, type EvaluationRecord, type UsageEntry } from '../models.ts';
import { redactAudit } from '../sqlite/shared.ts';
import { decodeCursor, now, pageFromRows, pageLimit, type Row, toIso } from './shared.ts';

export class PostgresInspectionRepository {
  constructor(private readonly pool: Pool) {}

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
      `SELECT *, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
       FROM ovo_ctl_evaluations WHERE workspace_id=$1
       AND ($2::timestamptz IS NULL OR (created_at,id) > ($2::timestamptz,$3::text))
       ORDER BY created_at,id LIMIT $4`,
      [workspaceId, after?.at ?? null, after?.id ?? '', size + 1],
    );
    return pageFromRows(
      result.rows,
      size,
      (row) => this.mapEvaluation(row),
      (row) => ({ at: String(row.cursor_at), id: String(row.id) }),
    );
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
      `SELECT *, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
       FROM ovo_ctl_usage_entries WHERE workspace_id=$1 AND call_id=$2
       AND ($3::timestamptz IS NULL OR (created_at,id) > ($3::timestamptz,$4::text))
       ORDER BY created_at,id LIMIT $5`,
      [workspaceId, callId, after?.at ?? null, after?.id ?? '', size + 1],
    );
    return pageFromRows(
      result.rows,
      size,
      (row) => this.mapUsage(row),
      (row) => ({ at: String(row.cursor_at), id: String(row.id) }),
    );
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
      `SELECT *, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
       FROM ovo_ctl_audit_entries WHERE workspace_id=$1
       AND ($2::timestamptz IS NULL OR (created_at,id) > ($2::timestamptz,$3::text))
       ORDER BY created_at,id LIMIT $4`,
      [workspaceId, after?.at ?? null, after?.id ?? '', size + 1],
    );
    return pageFromRows(
      result.rows,
      size,
      (row) => ({
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        actorId: String(row.actor_id),
        action: String(row.action),
        resourceType: String(row.resource_type),
        resourceId: String(row.resource_id),
        payload: row.payload as Record<string, unknown>,
        createdAt: toIso(row.created_at),
      }),
      (row) => ({ at: String(row.cursor_at), id: String(row.id) }),
    );
  }
}
