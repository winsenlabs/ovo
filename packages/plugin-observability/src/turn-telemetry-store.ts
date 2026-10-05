import type { Pool, PoolClient } from 'pg';
import type { TelemetryEvent } from './telemetry-types.ts';
import type { TurnTelemetry } from './turn-telemetry.ts';

/** Each summary is a full snapshot, so the newest sequence replaces the row. */
export async function updateTurnProjection(client: PoolClient, event: TelemetryEvent) {
  const summary = event.payload?.summary as TurnTelemetry | undefined;
  if (event.kind !== 'turn.summary' || !event.turnId || !summary || typeof summary !== 'object')
    return;
  const startedAt = typeof summary.startedAt === 'string' ? summary.startedAt : null;
  await client.query(
    `INSERT INTO ovo_telemetry_turns
       (workspace_id,call_id,turn_id,source,agent_id,release_id,started_at,updated_at,
        updated_sequence,summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (workspace_id,call_id,turn_id) DO UPDATE SET
       started_at=COALESCE(ovo_telemetry_turns.started_at,excluded.started_at),
       updated_at=excluded.updated_at,
       updated_sequence=excluded.updated_sequence,
       summary=excluded.summary
     WHERE excluded.updated_sequence > ovo_telemetry_turns.updated_sequence`,
    [
      event.workspaceId,
      event.callId,
      event.turnId,
      event.source,
      event.agentId ?? null,
      event.releaseId ?? null,
      startedAt,
      event.occurredAt,
      event.sequence,
      summary,
    ],
  );
}

export async function listTurnProjections(
  pool: Pool,
  workspaceId: string,
  callId: string,
  limit: number,
): Promise<TurnTelemetry[]> {
  const result = await pool.query<{ summary: TurnTelemetry }>(
    `SELECT summary FROM ovo_telemetry_turns WHERE workspace_id=$1 AND call_id=$2
     ORDER BY started_at NULLS LAST, updated_sequence LIMIT $3`,
    [workspaceId, callId, Math.min(500, Math.max(1, limit))],
  );
  return result.rows.map((row) => row.summary);
}

export async function pruneTurnProjections(client: PoolClient, before: string, limit: number) {
  await client.query(
    `WITH doomed AS (
       SELECT ctid FROM ovo_telemetry_turns WHERE updated_at<$1 ORDER BY updated_at LIMIT $2
     ) DELETE FROM ovo_telemetry_turns WHERE ctid IN (SELECT ctid FROM doomed)`,
    [before, limit],
  );
}
