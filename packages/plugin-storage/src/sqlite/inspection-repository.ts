import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AuditEntry, EvaluationRecord, Page, UsageEntry } from '../models.ts';
import {
  cursorValue,
  json,
  now,
  pageLimit,
  parseArray,
  parseObject,
  redactAudit,
  type Row,
} from './shared.ts';

export class InspectionRepository {
  constructor(private readonly db: DatabaseSync) {}
  private hasCall(workspaceId: string, id: string) {
    return !!this.db
      .prepare('SELECT 1 FROM calls WHERE workspace_id=? AND id=?')
      .get(workspaceId, id);
  }
  createEvaluation(input: {
    workspaceId: string;
    releaseId: string;
    status: 'passed' | 'failed';
    fixtures: unknown[];
    createdBy: string;
    id?: string;
  }) {
    const id = input.id ?? randomUUID();
    this.db
      .prepare(
        'INSERT INTO evaluations(id,workspace_id,release_id,status,fixtures_json,created_at,created_by) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        id,
        input.workspaceId,
        input.releaseId,
        input.status,
        json(input.fixtures),
        now(),
        input.createdBy,
      );
    return this.getEvaluation(input.workspaceId, id)!;
  }
  private mapEvaluation(row: Row): EvaluationRecord {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      releaseId: String(row.release_id),
      status: String(row.status) as EvaluationRecord['status'],
      fixtures: parseArray(row.fixtures_json),
      createdAt: String(row.created_at),
      createdBy: String(row.created_by),
    };
  }
  getEvaluation(workspaceId: string, id: string) {
    const row = this.db
      .prepare('SELECT * FROM evaluations WHERE workspace_id=? AND id=?')
      .get(workspaceId, id) as Row | undefined;
    return row ? this.mapEvaluation(row) : undefined;
  }
  listEvaluations(workspaceId: string, limit = 50, cursor?: string) {
    const size = pageLimit(limit),
      rows = this.db
        .prepare(
          'SELECT rowid AS cursor,* FROM evaluations WHERE workspace_id=? AND rowid>? ORDER BY rowid LIMIT ?',
        )
        .all(workspaceId, cursorValue(cursor), size + 1) as Row[],
      more = rows.length > size;
    if (more) rows.pop();
    return {
      items: rows.map((row) => this.mapEvaluation(row)),
      nextCursor: more ? String(rows.at(-1)!.cursor) : null,
    };
  }
  addUsage(input: Omit<UsageEntry, 'id' | 'createdAt'> & { id?: string }) {
    if (!/^\d+(\.\d+)?$/.test(input.quantity) || !/^\d+$/.test(input.amountMinor))
      throw new Error('Usage quantities must be nonnegative decimal strings');
    if (!this.hasCall(input.workspaceId, input.callId)) throw new Error('Call not found');
    const id = input.id ?? randomUUID(),
      createdAt = now();
    this.db
      .prepare(
        'INSERT INTO usage_entries(id,workspace_id,call_id,provider,request_id,quantity,unit,price_card_id,price_card_version,amount_minor,currency,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        input.workspaceId,
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
        createdAt,
      );
    return { ...input, id, createdAt };
  }
  listUsage(workspaceId: string, callId: string, limit = 50, cursor?: string) {
    if (!this.hasCall(workspaceId, callId)) throw new Error('Call not found');
    const size = pageLimit(limit),
      rows = this.db
        .prepare(
          'SELECT rowid AS cursor,* FROM usage_entries WHERE workspace_id=? AND call_id=? AND rowid>? ORDER BY rowid LIMIT ?',
        )
        .all(workspaceId, callId, cursorValue(cursor), size + 1) as Row[],
      more = rows.length > size;
    if (more) rows.pop();
    return {
      items: rows.map((row) => ({
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
        createdAt: String(row.created_at),
      })),
      nextCursor: more ? String(rows.at(-1)!.cursor) : null,
    };
  }
  audit(input: {
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
    this.db
      .prepare(
        'INSERT INTO audit_entries(id,workspace_id,actor_id,action,resource_type,resource_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        entry.id,
        entry.workspaceId,
        entry.actorId,
        entry.action,
        entry.resourceType,
        entry.resourceId,
        json(entry.payload),
        entry.createdAt,
      );
    return entry;
  }
  listAudit(workspaceId: string, limit = 50, cursor?: string): Page<AuditEntry> {
    const size = pageLimit(limit),
      rows = this.db
        .prepare(
          'SELECT rowid AS cursor,* FROM audit_entries WHERE workspace_id=? AND rowid>? ORDER BY rowid LIMIT ?',
        )
        .all(workspaceId, cursorValue(cursor), size + 1) as Row[],
      more = rows.length > size;
    if (more) rows.pop();
    return {
      items: rows.map((row) => ({
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        actorId: String(row.actor_id),
        action: String(row.action),
        resourceType: String(row.resource_type),
        resourceId: String(row.resource_id),
        payload: parseObject(row.payload_json),
        createdAt: String(row.created_at),
      })),
      nextCursor: more ? String(rows.at(-1)!.cursor) : null,
    };
  }
}
