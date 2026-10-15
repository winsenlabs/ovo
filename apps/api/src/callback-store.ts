import { randomUUID } from 'node:crypto';
import pg, { type Pool } from 'pg';
import {
  declaredDial,
  dialFromJob,
  type CallbackDial,
  type DialledReleaseConfig,
} from './callback-dial.ts';
import { runCallbackMigrations } from './callback-migrations.ts';

export { runCallbackMigrations } from './callback-migrations.ts';
export { dialFromJob, type CallbackDial, type DialledReleaseConfig } from './callback-dial.ts';

export const CALLBACK_STATUSES = [
  'pending',
  'dialing',
  'dialed',
  'completed',
  'cancelled',
] as const;
export type CallbackStatus = (typeof CALLBACK_STATUSES)[number];
export type CallbackSource = 'flow' | 'llm' | 'route';

/**
 * How long a dial may hold a callback in `dialing`. Placing a live call is only its durable
 * admission, so a claim older than this was left by an API that stopped mid-dial and may be retaken.
 */
export const DIAL_LEASE_SECONDS = 120;

export interface CallbackRecord {
  id: string;
  callId: string;
  dueAt: string;
  timezone: string;
  source: CallbackSource;
  node: string | null;
  disposition: string | null;
  reason: string | null;
  status: CallbackStatus;
  /** The agent release that promised it (a routed call); null dials the call's own release. */
  releaseId: string | null;
  /** The live call that dialled it back, once dialled. */
  dialedCallId: string | null;
  /** The number to call, masked to its last four digits; null when the call record is gone. */
  phone: string | null;
  createdAt: string;
  updatedAt: string;
}

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const ISO_INSTANT =
  '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})$';

interface Row {
  id: string;
  call_id: string;
  due_at: Date;
  timezone: string;
  source: CallbackSource;
  node: string | null;
  disposition: string | null;
  reason: string | null;
  status: CallbackStatus;
  release_id: string | null;
  dialed_call_id: string | null;
  created_at: Date;
  updated_at: Date;
  job: Record<string, unknown> | null;
}

/** Durable callbacks in the control database, beside the session events they come from. */
export class PostgresCallbackStore {
  private jobs?: Promise<boolean>;

  constructor(
    private readonly pool: Pool,
    private readonly owned = false,
  ) {}

  static async open(connection: {
    connectionString: string;
    maxConnections?: number;
  }): Promise<PostgresCallbackStore> {
    const pool = new pg.Pool({
      connectionString: connection.connectionString,
      max: connection.maxConnections ?? 2,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
    try {
      await runCallbackMigrations(pool);
    } catch (error) {
      await pool.end();
      throw error;
    }
    return new PostgresCallbackStore(pool, true);
  }

  /** Keeps every callback promised so far; one already kept is left as it is. */
  async sync(workspaceId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO ovo_callbacks (id, workspace_id, call_id, event_id, due_at, timezone, source,
         node, disposition, reason, release_id)
       SELECT gen_random_uuid(), e.workspace_id, e.call_id, e.id,
         (e.payload->'callback'->>'dueAt')::timestamptz,
         e.payload->'callback'->>'timezone',
         e.payload->'callback'->>'source',
         e.payload->'callback'->>'node',
         e.payload->>'disposition',
         e.payload->'callback'->>'reason',
         -- The release a routed call stamped; anything but a uuid dials the call's own release.
         CASE WHEN e.payload->'callback'->>'releaseId' ~ '${UUID}'
           THEN (e.payload->'callback'->>'releaseId')::uuid END
       FROM ovo_session_events e
       WHERE e.workspace_id = $1 AND e.type = 'disposition' AND e.payload ? 'callback'
         AND e.payload->'callback'->>'source' IN ('flow', 'llm', 'route')
         AND e.payload->'callback'->>'timezone' IS NOT NULL
         -- An event that does not carry an ISO instant is skipped, never allowed to fail the sync.
         AND e.payload->'callback'->>'dueAt' ~ '${ISO_INSTANT}'
       ON CONFLICT (workspace_id, call_id, event_id) DO NOTHING`,
      [workspaceId],
    );
  }

  /** Soonest due first; a cursor is the last row's `<dueAt>|<id>`. */
  async list(
    workspaceId: string,
    query: { status?: CallbackStatus; limit: number; cursor?: string },
  ): Promise<{ items: CallbackRecord[]; nextCursor: string | null }> {
    const [dueAt, id] = query.cursor?.split('|') ?? [];
    const rows = await this.select(
      `c.workspace_id = $1 AND ($2::text IS NULL OR c.status = $2)
       AND ($3::timestamptz IS NULL OR (c.due_at, c.id) > ($3::timestamptz, $4::uuid))
       ORDER BY c.due_at, c.id LIMIT $5`,
      [workspaceId, query.status ?? null, dueAt ?? null, id ?? null, query.limit + 1],
    );
    const items = rows.slice(0, query.limit).map(present);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > query.limit && last ? `${last.dueAt}|${last.id}` : null,
    };
  }

  async get(workspaceId: string, id: string): Promise<CallbackRecord | undefined> {
    const [row] = await this.select('c.workspace_id = $1 AND c.id = $2', [workspaceId, id]);
    return row ? present(row) : undefined;
  }

  /** Moves a callback on only from one of `from`: undefined when missing, `conflict` otherwise. */
  async transition(
    workspaceId: string,
    id: string,
    from: readonly CallbackStatus[],
    to: CallbackStatus,
    dialedCallId?: string,
  ): Promise<CallbackRecord | 'conflict' | undefined> {
    const updated = await this.pool.query(
      `UPDATE ovo_callbacks SET status = $4, updated_at = now(),
         dialed_call_id = COALESCE($5, dialed_call_id)
       WHERE workspace_id = $1 AND id = $2 AND status = ANY($3::text[])`,
      [workspaceId, id, from, to, dialedCallId ?? null],
    );
    const current = await this.get(workspaceId, id);
    if (!current) return undefined;
    return updated.rowCount ? current : 'conflict';
  }

  /**
   * Claims a pending callback, or one whose dial lease ran out, for dialling and returns what to
   * dial it with. The operation id is kept, so a dial retried after a failure (or after an API that
   * stopped mid-dial) is the same live call, never a second one. With `release`, the call's
   * variables are cut to what the dialled release declares (R1 audit 2): a routed call carries
   * the router's variables, which a member or default agent with a closed schema would refuse.
   */
  async claimDial(
    workspaceId: string,
    id: string,
    release?: DialledReleaseConfig,
  ): Promise<CallbackDial | 'conflict' | 'unreachable' | undefined> {
    const claimed = await this.pool.query<{
      dial_operation_id: string;
      call_id: string;
      release_id: string | null;
    }>(
      `UPDATE ovo_callbacks SET status = 'dialing', updated_at = now(),
         dial_operation_id = COALESCE(dial_operation_id, $3::uuid)
       WHERE workspace_id = $1 AND id = $2 AND (status = 'pending'
         OR (status = 'dialing' AND updated_at < now() - make_interval(secs => $4)))
       RETURNING dial_operation_id, call_id, release_id`,
      [workspaceId, id, randomUUID(), DIAL_LEASE_SECONDS],
    );
    const row = claimed.rows[0];
    if (!row) return (await this.get(workspaceId, id)) ? 'conflict' : undefined;
    const job = await this.job(row.call_id);
    const dial = job ? dialFromJob(job, row.release_id) : undefined;
    if (!dial) {
      await this.transition(workspaceId, id, ['dialing'], 'pending');
      return 'unreachable';
    }
    const config = await release?.(dial.releaseId);
    return { operationId: row.dial_operation_id, ...(config ? declaredDial(dial, config) : dial) };
  }

  async close(): Promise<void> {
    if (this.owned) await this.pool.end();
  }

  private async select(where: string, values: unknown[]): Promise<Row[]> {
    const jobs = await this.hasJobs();
    const result = await this.pool.query<Row>(
      `SELECT c.id, c.call_id, c.due_at, c.timezone, c.source, c.node, c.disposition, c.reason,
         c.status, c.release_id, c.dialed_call_id, c.created_at, c.updated_at,
         ${jobs ? 'j.payload' : 'NULL::jsonb'} AS job
       FROM ovo_callbacks c
       ${jobs ? `LEFT JOIN ovo_jobs j ON j.id = (CASE WHEN c.call_id ~ '${UUID}' THEN c.call_id::uuid END)` : ''}
       WHERE ${where}`,
      values,
    );
    return result.rows;
  }

  private async job(callId: string): Promise<Record<string, unknown> | undefined> {
    if (!new RegExp(UUID).test(callId) || !(await this.hasJobs())) return undefined;
    const result = await this.pool.query<{ payload: Record<string, unknown> }>(
      'SELECT payload FROM ovo_jobs WHERE id = $1::uuid',
      [callId],
    );
    return result.rows[0]?.payload;
  }

  /** The orchestration schema exists wherever a worker ran; an API-only database has no jobs. */
  private hasJobs(): Promise<boolean> {
    this.jobs ??= this.pool
      .query<{ found: boolean }>("SELECT to_regclass('ovo_jobs') IS NOT NULL AS found")
      .then((result) => result.rows[0]?.found === true);
    this.jobs.catch(() => (this.jobs = undefined));
    return this.jobs;
  }
}

function present(row: Row): CallbackRecord {
  const dial = row.job ? dialFromJob(row.job) : undefined;
  return {
    id: row.id,
    callId: row.call_id,
    dueAt: row.due_at.toISOString(),
    timezone: row.timezone,
    source: row.source,
    node: row.node,
    disposition: row.disposition,
    reason: row.reason,
    status: row.status,
    releaseId: row.release_id,
    dialedCallId: row.dialed_call_id,
    phone: dial ? `••••${dial.to.slice(-4)}` : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
