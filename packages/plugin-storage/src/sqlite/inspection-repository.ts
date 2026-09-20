import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AuditEntry,
  CallRecord,
  EvaluationRecord,
  Page,
  StoredCallEvent,
  UsageEntry,
} from '../models.ts';
import {
  cursorValue,
  json,
  now,
  pageLimit,
  parseArray,
  parseObject,
  redactAudit,
  type Row,
  transaction,
} from './shared.ts';

export class InspectionRepository {
  constructor(private readonly db: DatabaseSync) {}
  createCall(input: {
    workspaceId: string;
    releaseId: string;
    kind: 'live' | 'simulation';
    status: string;
    id?: string;
  }) {
    const id = input.id ?? randomUUID(),
      at = now();
    this.db
      .prepare(
        'INSERT INTO calls(id,workspace_id,release_id,kind,status,created_at) VALUES(?,?,?,?,?,?)',
      )
      .run(id, input.workspaceId, input.releaseId, input.kind, input.status, at);
    return this.getCall(input.workspaceId, id)!;
  }
  private mapCall(row: Row): CallRecord {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      releaseId: String(row.release_id),
      kind: String(row.kind) as CallRecord['kind'],
      status: String(row.status),
      createdAt: String(row.created_at),
      completedAt: row.completed_at === null ? null : String(row.completed_at),
    };
  }
  getCall(workspaceId: string, id: string) {
    const row = this.db
      .prepare('SELECT * FROM calls WHERE workspace_id=? AND id=?')
      .get(workspaceId, id) as Row | undefined;
    return row ? this.mapCall(row) : undefined;
  }
  listCalls(workspaceId: string, limit = 50, cursor?: string): Page<CallRecord> {
    const size = pageLimit(limit),
      rows = this.db
        .prepare(
          'SELECT rowid AS cursor,* FROM calls WHERE workspace_id=? AND rowid>? ORDER BY rowid LIMIT ?',
        )
        .all(workspaceId, cursorValue(cursor), size + 1) as Row[],
      more = rows.length > size;
    if (more) rows.pop();
    return {
      items: rows.map((row) => this.mapCall(row)),
      nextCursor: more ? String(rows.at(-1)!.cursor) : null,
    };
  }
  finishCall(workspaceId: string, id: string, status: string) {
    const result = this.db
      .prepare('UPDATE calls SET status=?,completed_at=? WHERE workspace_id=? AND id=?')
      .run(status, now(), workspaceId, id);
    if (!result.changes) throw new Error('Call not found');
    return this.getCall(workspaceId, id)!;
  }
  appendCallEvent(
    workspaceId: string,
    callId: string,
    type: string,
    payload: Record<string, unknown>,
    epoch = 0,
  ): StoredCallEvent {
    return transaction(this.db, () => {
      if (!this.getCall(workspaceId, callId)) throw new Error('Call not found');
      const sequence = Number(
          (
            this.db
              .prepare(
                'SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM call_events WHERE call_id=?',
              )
              .get(callId) as Row
          ).sequence,
        ),
        event = { id: randomUUID(), callId, sequence, at: now(), type, epoch, payload };
      this.db
        .prepare(
          'INSERT INTO call_events(id,call_id,sequence,at,type,epoch,payload_json) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          event.id,
          event.callId,
          event.sequence,
          event.at,
          event.type,
          event.epoch,
          json(event.payload),
        );
      return event;
    });
  }
  listCallEvents(workspaceId: string, callId: string) {
    if (!this.getCall(workspaceId, callId)) throw new Error('Call not found');
    return (
      this.db
        .prepare('SELECT * FROM call_events WHERE call_id=? ORDER BY sequence')
        .all(callId) as Row[]
    ).map((row) => ({
      id: String(row.id),
      callId: String(row.call_id),
      sequence: Number(row.sequence),
      at: String(row.at),
      type: String(row.type),
      epoch: Number(row.epoch),
      payload: parseObject(row.payload_json),
    }));
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
  listEvaluations(workspaceId: string) {
    return (
      this.db
        .prepare('SELECT * FROM evaluations WHERE workspace_id=? ORDER BY created_at DESC')
        .all(workspaceId) as Row[]
    ).map((row) => this.mapEvaluation(row));
  }
  addUsage(input: Omit<UsageEntry, 'id' | 'createdAt'> & { id?: string }) {
    if (!/^\d+(\.\d+)?$/.test(input.quantity) || !/^\d+$/.test(input.amountMinor))
      throw new Error('Usage quantities must be nonnegative decimal strings');
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
  listUsage(workspaceId: string, callId: string): UsageEntry[] {
    if (!this.getCall(workspaceId, callId)) throw new Error('Call not found');
    return (
      this.db
        .prepare(
          'SELECT * FROM usage_entries WHERE workspace_id=? AND call_id=? ORDER BY created_at',
        )
        .all(workspaceId, callId) as Row[]
    ).map((row) => ({
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
    }));
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
