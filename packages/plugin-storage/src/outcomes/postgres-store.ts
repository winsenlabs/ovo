import pg from 'pg';
import type { Pool } from 'pg';
import {
  readSessionEvent,
  type CallOutcomeSummary,
  type SessionEvent,
} from '@winsendotai/ovo-contracts';
import { toIso, transaction, type Row } from '../postgres/shared.ts';
import { runCallOutcomeMigrations } from './migrations.ts';
import { applySessionEvent, emptyCallOutcome } from './projection.ts';
import {
  eventCursor,
  eventPageLimit,
  type CallOutcomeStore,
  type SessionEventInput,
} from './store.ts';

/** A batch is one transaction; the sink never sends more than this many events at once. */
export const SESSION_EVENT_BATCH_MAX = 100;

/**
 * Outcome writes fail fast instead of waiting on PostgreSQL forever (pg's defaults): the sink
 * retries a batch, and nothing on the call path waits on it.
 */
export const CALL_OUTCOME_POOL_TIMEOUTS = Object.freeze({
  connectionTimeoutMillis: 2_000,
  statement_timeout: 10_000,
});

export class PostgresCallOutcomeStore implements CallOutcomeStore {
  constructor(
    private readonly pool: Pool,
    private readonly ownsPool = false,
  ) {}

  /** Opens a small pool, applies the outcome migrations and returns the store that owns the pool. */
  static async open(connection: {
    connectionString: string;
    maxConnections?: number;
  }): Promise<PostgresCallOutcomeStore> {
    const pool = new pg.Pool({
      connectionString: connection.connectionString,
      max: connection.maxConnections ?? 2,
      ...CALL_OUTCOME_POOL_TIMEOUTS,
    });
    try {
      await runCallOutcomeMigrations(pool);
    } catch (error) {
      await pool.end();
      throw error;
    }
    return new PostgresCallOutcomeStore(pool, true);
  }

  async append(workspaceId: string, callId: string, inputs: readonly SessionEventInput[]) {
    if (inputs.length > SESSION_EVENT_BATCH_MAX)
      throw new RangeError(`At most ${SESSION_EVENT_BATCH_MAX} session events per append`);
    // Validated before the transaction: one bad event refuses the batch without touching the call.
    const events = inputs.map((input) => ({
      input,
      event: readSessionEvent(input.type, input.payload),
    }));
    if (!events.length) return 0;
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        workspaceId,
        callId,
      ]);
      const seen = await client.query<{ id: string }>(
        'SELECT id FROM ovo_session_events WHERE workspace_id=$1 AND call_id=$2 AND id = ANY($3::text[])',
        [workspaceId, callId, events.map(({ input }) => input.id)],
      );
      const known = new Set(seen.rows.map((row) => row.id));
      const fresh = events.filter(({ input }) => {
        if (known.has(input.id)) return false;
        known.add(input.id);
        return true;
      });
      if (!fresh.length) return 0;
      const last = await client.query<{ sequence: number }>(
        'SELECT COALESCE(MAX(sequence),0)::int AS sequence FROM ovo_session_events WHERE workspace_id=$1 AND call_id=$2',
        [workspaceId, callId],
      );
      const base = Number(last.rows[0]!.sequence);
      const values: unknown[] = [workspaceId, callId];
      const rows = fresh.map(({ input, event }, index) => {
        const at = values.push(base + index + 1, input.id, input.at, event.type, event.payload);
        return `($1,$2,$${at - 4},$${at - 3},$${at - 2},$${at - 1},$${at})`;
      });
      await client.query(
        `INSERT INTO ovo_session_events (workspace_id,call_id,sequence,id,at,type,payload)
         VALUES ${rows.join(',')}`,
        values,
      );
      const current = await client.query<Row>(
        'SELECT * FROM ovo_call_outcomes WHERE workspace_id=$1 AND call_id=$2 FOR UPDATE',
        [workspaceId, callId],
      );
      let summary = current.rowCount
        ? mapOutcome(current.rows[0]!)
        : emptyCallOutcome(callId, fresh[0]!.input.at);
      for (const { input, event } of fresh)
        summary = applySessionEvent(summary, event as SessionEvent, input.at);
      await upsertOutcome(client, workspaceId, summary);
      return fresh.length;
    });
  }

  async get(workspaceId: string, callId: string) {
    const result = await this.pool.query<Row>(
      'SELECT * FROM ovo_call_outcomes WHERE workspace_id=$1 AND call_id=$2',
      [workspaceId, callId],
    );
    return result.rowCount ? mapOutcome(result.rows[0]!) : undefined;
  }

  async getMany(workspaceId: string, callIds: readonly string[]) {
    const found = new Map<string, CallOutcomeSummary>();
    if (!callIds.length) return found;
    const result = await this.pool.query<Row>(
      'SELECT * FROM ovo_call_outcomes WHERE workspace_id=$1 AND call_id = ANY($2::text[])',
      [workspaceId, [...callIds]],
    );
    for (const row of result.rows) found.set(String(row.call_id), mapOutcome(row));
    return found;
  }

  async listEvents(workspaceId: string, callId: string, limit?: number, cursor?: string) {
    const size = eventPageLimit(limit);
    const after = eventCursor(cursor);
    const result = await this.pool.query<Row>(
      `SELECT call_id,sequence,at,type,payload FROM ovo_session_events
       WHERE workspace_id=$1 AND call_id=$2 AND sequence>$3 ORDER BY sequence LIMIT $4`,
      [workspaceId, callId, after, size + 1],
    );
    const more = result.rows.length > size;
    if (more) result.rows.pop();
    return {
      items: result.rows.map((row) => ({
        callId: String(row.call_id),
        sequence: Number(row.sequence),
        at: toIso(row.at),
        type: String(row.type) as SessionEvent['type'],
        payload: row.payload as Record<string, unknown>,
      })),
      nextCursor: more ? String(result.rows.at(-1)!.sequence) : null,
    };
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }
}

async function upsertOutcome(
  client: pg.PoolClient,
  workspaceId: string,
  summary: CallOutcomeSummary,
): Promise<void> {
  await client.query(
    `INSERT INTO ovo_call_outcomes (workspace_id,call_id,outcome,end_reason,disposition,
       disposition_source,final_node,state_path,variables,tiers,guardrail_flagged,guardrail_blocked,
       events,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14)
     ON CONFLICT (workspace_id,call_id) DO UPDATE SET outcome=EXCLUDED.outcome,
       end_reason=EXCLUDED.end_reason, disposition=EXCLUDED.disposition,
       disposition_source=EXCLUDED.disposition_source, final_node=EXCLUDED.final_node,
       state_path=EXCLUDED.state_path, variables=EXCLUDED.variables, tiers=EXCLUDED.tiers,
       guardrail_flagged=EXCLUDED.guardrail_flagged, guardrail_blocked=EXCLUDED.guardrail_blocked,
       events=EXCLUDED.events, updated_at=EXCLUDED.updated_at`,
    [
      workspaceId,
      summary.callId,
      summary.outcome,
      summary.endReason,
      summary.disposition,
      summary.dispositionSource,
      summary.finalNode,
      JSON.stringify(summary.statePath),
      JSON.stringify(summary.variables),
      JSON.stringify(summary.tiers),
      summary.guardrail.flagged,
      summary.guardrail.blocked,
      summary.events,
      summary.updatedAt,
    ],
  );
}

function mapOutcome(row: Row): CallOutcomeSummary {
  const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
  return {
    callId: String(row.call_id),
    outcome: text(row.outcome),
    endReason: text(row.end_reason),
    disposition: text(row.disposition),
    dispositionSource: text(row.disposition_source),
    finalNode: text(row.final_node),
    statePath: row.state_path as string[],
    variables: row.variables as Record<string, unknown>,
    tiers: row.tiers as CallOutcomeSummary['tiers'],
    guardrail: { flagged: Number(row.guardrail_flagged), blocked: Number(row.guardrail_blocked) },
    events: Number(row.events),
    updatedAt: toIso(row.updated_at),
  };
}
