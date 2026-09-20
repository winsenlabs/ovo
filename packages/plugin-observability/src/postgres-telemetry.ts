import pg, { type Pool, type PoolClient } from 'pg';
import { migrateTelemetry } from './telemetry-migrations.ts';
import {
  updateCallProjection,
  updateOperationProjection,
  updatePlaybackProjection,
  updateStageProjection,
} from './telemetry-projections.ts';
import { runPerformanceQuery } from './performance-query.ts';
import type {
  CallTelemetryProjection,
  PerformanceQuery,
  TelemetryEvent,
  TelemetryIngestResult,
  TelemetryRepository,
  TelemetryStreamPage,
} from './telemetry-types.ts';
import { telemetryEventHash } from './telemetry-validation.ts';

const { Pool: PgPool } = pg;

export interface PostgresTelemetryOptions {
  connectionString?: string;
  pool?: Pool;
  maxConnections?: number;
  maxQueryWindowDays?: number;
}

export class PostgresTelemetryStore implements TelemetryRepository {
  private constructor(
    private readonly pool: Pool,
    private readonly ownsPool: boolean,
    private readonly maxQueryWindowDays: number,
  ) {}

  static async open(options: string | PostgresTelemetryOptions): Promise<PostgresTelemetryStore> {
    const normalized = typeof options === 'string' ? { connectionString: options } : options;
    if (!normalized.pool && !normalized.connectionString)
      throw new Error('Telemetry PostgreSQL connection is required');
    const pool =
      normalized.pool ??
      new PgPool({
        connectionString: normalized.connectionString,
        max: normalized.maxConnections ?? 2,
      });
    const store = new PostgresTelemetryStore(
      pool,
      !normalized.pool,
      normalized.maxQueryWindowDays ?? 31,
    );
    try {
      await store.migrate();
    } catch (error) {
      await store.close();
      throw error;
    }
    return store;
  }

  private async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await migrateTelemetry(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async ingest(events: readonly TelemetryEvent[]): Promise<TelemetryIngestResult> {
    if (events.length > 100) throw new Error('Telemetry batch exceeds 100 events');
    const result = { inserted: 0, duplicates: 0, conflicts: 0 };
    if (!events.length) return result;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const event of events) await this.ingestOne(client, event, result);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async ingestOne(
    client: PoolClient,
    event: TelemetryEvent,
    result: TelemetryIngestResult,
  ): Promise<void> {
    const hash = telemetryEventHash(event);
    const inserted = await client.query(
      `INSERT INTO ovo_telemetry_events
       (schema_version,workspace_id,call_id,sequence,event_id,event_hash,occurred_at,source,kind,
        agent_id,release_id,provider,model,language,turn_id,response_epoch,stage_id,stage,
        operation_id,segment_id,duration_ms,outcome,evidence,payload)
       VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       ON CONFLICT DO NOTHING RETURNING sequence`,
      [
        event.workspaceId,
        event.callId,
        event.sequence,
        event.eventId,
        hash,
        event.occurredAt,
        event.source,
        event.kind,
        event.agentId ?? null,
        event.releaseId ?? null,
        event.provider ?? null,
        event.model ?? null,
        event.language ?? null,
        event.turnId ?? null,
        event.responseEpoch ?? null,
        event.stageId ?? null,
        event.stage ?? null,
        event.operationId ?? null,
        event.segmentId ?? null,
        event.durationMs ?? null,
        event.outcome ?? null,
        event.evidence ?? null,
        event.payload ?? {},
      ],
    );
    if (!inserted.rowCount) {
      const existing = await client.query<{ event_hash: Buffer }>(
        `SELECT event_hash FROM ovo_telemetry_events
         WHERE workspace_id=$1 AND event_id=$2 AND call_id=$3 AND sequence=$4`,
        [event.workspaceId, event.eventId, event.callId, event.sequence],
      );
      if (existing.rows[0]?.event_hash.equals(hash)) result.duplicates++;
      else result.conflicts++;
      return;
    }
    result.inserted++;
    await updateCallProjection(client, event);
    await updateStageProjection(client, event);
    await updatePlaybackProjection(client, event);
    await updateOperationProjection(client, event);
  }

  async listCallEvents(
    workspaceId: string,
    callId: string,
    afterSequence: number,
    limit = 100,
  ): Promise<TelemetryStreamPage> {
    const bounded = Math.min(500, Math.max(1, limit));
    const result = await this.pool.query(
      `SELECT * FROM ovo_telemetry_events
       WHERE workspace_id=$1 AND call_id=$2 AND sequence>$3
       ORDER BY sequence LIMIT $4`,
      [workspaceId, callId, afterSequence, bounded],
    );
    const events = result.rows.map(mapEvent);
    const expected = afterSequence + 1;
    const actual = events[0]?.sequence;
    return {
      events,
      nextCursor: events.at(-1)?.sequence ?? afterSequence,
      gap: actual !== undefined && actual !== expected ? { expected, actual } : null,
    };
  }

  async getCallProjection(workspaceId: string, callId: string, limit = 200) {
    const bounded = Math.min(500, Math.max(1, limit));
    const [call, stages, playback, operations] = await Promise.all([
      this.pool.query('SELECT * FROM ovo_telemetry_calls WHERE workspace_id=$1 AND call_id=$2', [
        workspaceId,
        callId,
      ]),
      this.pool.query(
        'SELECT * FROM ovo_telemetry_stages WHERE workspace_id=$1 AND call_id=$2 ORDER BY COALESCE(started_at,finished_at),stage_id LIMIT $3',
        [workspaceId, callId, bounded],
      ),
      this.pool.query(
        'SELECT * FROM ovo_telemetry_playback WHERE workspace_id=$1 AND call_id=$2 ORDER BY updated_sequence LIMIT $3',
        [workspaceId, callId, bounded],
      ),
      this.pool.query(
        'SELECT * FROM ovo_telemetry_operations WHERE workspace_id=$1 AND call_id=$2 ORDER BY updated_sequence LIMIT $3',
        [workspaceId, callId, bounded],
      ),
    ]);
    if (!call.rows[0]) return undefined;
    return mapProjection(call.rows[0], stages.rows, playback.rows, operations.rows);
  }

  queryPerformance(workspaceId: string, query: PerformanceQuery) {
    return runPerformanceQuery(this.pool, workspaceId, query, this.maxQueryWindowDays);
  }

  async prune(before: string, limit = 1_000): Promise<number> {
    if (!Number.isFinite(Date.parse(before))) throw new Error('Invalid retention cutoff');
    const bounded = Math.min(10_000, Math.max(1, limit));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `WITH doomed AS (
         SELECT ctid FROM ovo_telemetry_events WHERE occurred_at<$1 ORDER BY occurred_at LIMIT $2
       ) DELETE FROM ovo_telemetry_events WHERE ctid IN (SELECT ctid FROM doomed)`,
        [before, bounded],
      );
      await client.query(
        `WITH doomed AS (
           SELECT ctid FROM ovo_telemetry_stages
           WHERE COALESCE(finished_at,started_at)<$1
           ORDER BY COALESCE(finished_at,started_at) LIMIT $2
         ) DELETE FROM ovo_telemetry_stages WHERE ctid IN (SELECT ctid FROM doomed)`,
        [before, bounded],
      );
      await client.query(
        `WITH doomed AS (
           SELECT ctid FROM ovo_telemetry_playback
           WHERE COALESCE(completed_at,acknowledged_at,sent_at,started_at,generated_at)<$1
           ORDER BY COALESCE(completed_at,acknowledged_at,sent_at,started_at,generated_at) LIMIT $2
         ) DELETE FROM ovo_telemetry_playback WHERE ctid IN (SELECT ctid FROM doomed)`,
        [before, bounded],
      );
      await client.query(
        `WITH doomed AS (
           SELECT ctid FROM ovo_telemetry_operations
           WHERE COALESCE(settled_at,started_at)<$1
           ORDER BY COALESCE(settled_at,started_at) LIMIT $2
         ) DELETE FROM ovo_telemetry_operations WHERE ctid IN (SELECT ctid FROM doomed)`,
        [before, bounded],
      );
      await client.query(
        `WITH doomed AS (
           SELECT c.ctid FROM ovo_telemetry_calls c
           WHERE c.last_at<$1 AND NOT EXISTS (
             SELECT 1 FROM ovo_telemetry_events e
             WHERE e.workspace_id=c.workspace_id AND e.call_id=c.call_id
           )
           ORDER BY c.last_at LIMIT $2
         ) DELETE FROM ovo_telemetry_calls WHERE ctid IN (SELECT ctid FROM doomed)`,
        [before, bounded],
      );
      await client.query('COMMIT');
      return result.rowCount ?? 0;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}

function mapEvent(row: Record<string, any>) {
  return {
    schemaVersion: 1 as const,
    eventId: row.event_id,
    workspaceId: row.workspace_id,
    callId: row.call_id,
    sequence: Number(row.sequence),
    occurredAt: new Date(row.occurred_at).toISOString(),
    ingestedAt: new Date(row.ingested_at).toISOString(),
    source: row.source,
    kind: row.kind,
    agentId: row.agent_id ?? undefined,
    releaseId: row.release_id ?? undefined,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    language: row.language ?? undefined,
    turnId: row.turn_id ?? undefined,
    responseEpoch: row.response_epoch === null ? undefined : Number(row.response_epoch),
    stageId: row.stage_id ?? undefined,
    stage: row.stage ?? undefined,
    operationId: row.operation_id ?? undefined,
    segmentId: row.segment_id ?? undefined,
    durationMs: row.duration_ms === null ? undefined : Number(row.duration_ms),
    outcome: row.outcome ?? undefined,
    evidence: row.evidence ?? undefined,
    payload: row.payload,
  };
}

function iso(value: unknown): string | null {
  return value ? new Date(value as string).toISOString() : null;
}

function mapProjection(
  call: any,
  stages: any[],
  playback: any[],
  operations: any[],
): CallTelemetryProjection {
  return {
    callId: call.call_id,
    source: call.source,
    lastSequence: Number(call.last_sequence),
    eventCount: Number(call.event_count),
    gapDetected: call.gap_detected,
    status: call.status,
    stages: stages.map((row) => ({
      stageId: row.stage_id,
      stage: row.stage,
      startedAt: iso(row.started_at),
      finishedAt: iso(row.finished_at),
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      outcome: row.outcome,
    })),
    playback: playback.map((row) => ({
      segmentId: row.segment_id,
      responseEpoch: row.response_epoch === null ? null : Number(row.response_epoch),
      kind: row.speech_kind,
      generatedAt: iso(row.generated_at),
      sentAt: iso(row.sent_at),
      acknowledgedAt: iso(row.acknowledged_at),
      completedAt: iso(row.completed_at),
      terminalState: row.terminal_state,
      evidence: row.evidence,
    })),
    operations: operations.map((row) => ({
      operationId: row.operation_id,
      toolId: row.tool_id,
      state: row.state,
      startedAt: iso(row.started_at),
      settledAt: iso(row.settled_at),
    })),
  };
}
