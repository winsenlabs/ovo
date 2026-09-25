import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CallListFilters } from '../control-store.ts';
import type { CallRecord, Page, StoredCallEvent } from '../models.ts';
import { decodeCursor, encodeCursor } from '../postgres/shared.ts';
import { cursorValue, json, now, pageLimit, parseObject, type Row, transaction } from './shared.ts';

export class CallsRepository {
  constructor(private readonly db: DatabaseSync) {}
  createCall(input: {
    workspaceId: string;
    releaseId: string;
    kind: CallRecord['kind'];
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
  listCalls(
    workspaceId: string,
    limit = 50,
    cursor?: string,
    filters: CallListFilters = {},
  ): Page<CallRecord> {
    const size = pageLimit(limit),
      after = decodeCursor(cursor),
      ascending = filters.order === 'asc',
      rows = this.db
        .prepare(
          `SELECT c.* FROM calls c JOIN releases r ON r.workspace_id=c.workspace_id AND r.id=c.release_id
          WHERE c.workspace_id=? AND (? IS NULL OR (c.created_at,c.id) ${ascending ? '>' : '<'} (?,?))
          AND (? IS NULL OR r.agent_id=?) AND (? IS NULL OR c.kind=?) AND (? IS NULL OR c.status=?)
          AND (? IS NULL OR json_extract(r.selections_json,'$.engine.pluginId')=?)
          AND (? IS NULL OR json_extract(r.selections_json,'$.carrier.pluginId')=?)
          ORDER BY c.created_at ${ascending ? 'ASC' : 'DESC'},c.id ${ascending ? 'ASC' : 'DESC'} LIMIT ?`,
        )
        .all(
          workspaceId,
          after?.at ?? null,
          after?.at ?? '',
          after?.id ?? '',
          filters.agentId ?? null,
          filters.agentId ?? null,
          filters.kind ?? null,
          filters.kind ?? null,
          filters.status ?? null,
          filters.status ?? null,
          filters.engine ?? null,
          filters.engine ?? null,
          filters.carrier ?? null,
          filters.carrier ?? null,
          size + 1,
        ) as Row[],
      more = rows.length > size;
    if (more) rows.pop();
    return {
      items: rows.map((row) => this.mapCall(row)),
      nextCursor: more
        ? encodeCursor({ at: String(rows.at(-1)!.created_at), id: String(rows.at(-1)!.id) })
        : null,
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
  listCallEvents(workspaceId: string, callId: string, limit = 50, cursor?: string) {
    if (!this.getCall(workspaceId, callId)) throw new Error('Call not found');
    const size = pageLimit(limit),
      after = cursorValue(cursor),
      rows = this.db
        .prepare(
          'SELECT * FROM call_events WHERE call_id=? AND sequence>? ORDER BY sequence LIMIT ?',
        )
        .all(callId, after, size + 1) as Row[],
      more = rows.length > size;
    if (more) rows.pop();
    return {
      items: rows.map((row) => ({
        id: String(row.id),
        callId: String(row.call_id),
        sequence: Number(row.sequence),
        at: String(row.at),
        type: String(row.type),
        epoch: Number(row.epoch),
        payload: parseObject(row.payload_json),
      })),
      nextCursor: more ? String(rows.at(-1)!.sequence) : null,
    };
  }
}
