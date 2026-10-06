import { randomUUID } from 'node:crypto';
import pg, { type Pool } from 'pg';
import { runCallOutcomeMigrations } from '@winsendotai/ovo-plugin-storage/outcomes';

export const CALLBACK_STATUSES = [
  'pending',
  'dialing',
  'dialed',
  'completed',
  'cancelled',
] as const;
export type CallbackStatus = (typeof CALLBACK_STATUSES)[number];

export interface CallbackRecord {
  id: string;
  callId: string;
  dueAt: string;
  timezone: string;
  source: 'flow' | 'llm';
  node: string | null;
  disposition: string | null;
  reason: string | null;
  status: CallbackStatus;
  /** The live call that dialled it back, once dialled. */
  dialedCallId: string | null;
  /** The number to call, masked to its last four digits; null when the call record is gone. */
  phone: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What `POST /v1/calls` needs to dial a callback: the same release, numbers swapped for inbound. */
export interface CallbackDial {
  operationId: string;
  releaseId: string;
  to: string;
  fromNumber: string;
  variables: Record<string, string>;
}

/**
 * v1 (AGT-15). A callback is promised during a call as a `disposition` session event carrying a
 * `callback` field; this table adds what happens to it afterwards. The partial index keeps the sync
 * from scanning every session event: only callback dispositions enter it.
 */
export const callbacksV1 = `
CREATE TABLE IF NOT EXISTS ovo_callbacks (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL CHECK (length(workspace_id) > 0),
  call_id text NOT NULL CHECK (length(call_id) BETWEEN 1 AND 200),
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 100),
  due_at timestamptz NOT NULL,
  timezone text NOT NULL,
  source text NOT NULL CHECK (source IN ('flow', 'llm')),
  node text,
  disposition text,
  reason text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'dialing', 'dialed', 'completed', 'cancelled')),
  dial_operation_id uuid,
  dialed_call_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, call_id, event_id)
);
CREATE INDEX IF NOT EXISTS ovo_callbacks_due ON ovo_callbacks (workspace_id, status, due_at, id);
CREATE INDEX IF NOT EXISTS ovo_session_events_callbacks ON ovo_session_events (workspace_id)
  WHERE type = 'disposition' AND payload ? 'callback';
`;

const MIGRATIONS: readonly string[] = [callbacksV1];

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const ISO_INSTANT =
  '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})$';

/** Idempotent and safe to race, like the outcome migrations it builds on. */
export async function runCallbackMigrations(pool: Pool): Promise<void> {
  await runCallOutcomeMigrations(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SET LOCAL statement_timeout = 0; SELECT pg_advisory_xact_lock(hashtext('ovo-callback-migrations'));" +
        ' CREATE TABLE IF NOT EXISTS ovo_callback_schema_migrations' +
        ' (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const applied = await client.query<{ version: number }>(
      'SELECT version FROM ovo_callback_schema_migrations',
    );
    const done = new Set(applied.rows.map((row) => Number(row.version)));
    for (let version = 1; version <= MIGRATIONS.length; version += 1) {
      if (done.has(version)) continue;
      await client.query(MIGRATIONS[version - 1]!);
      await client.query('INSERT INTO ovo_callback_schema_migrations (version) VALUES ($1)', [
        version,
      ]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

interface Row {
  id: string;
  call_id: string;
  due_at: Date;
  timezone: string;
  source: 'flow' | 'llm';
  node: string | null;
  disposition: string | null;
  reason: string | null;
  status: CallbackStatus;
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
         node, disposition, reason)
       SELECT gen_random_uuid(), e.workspace_id, e.call_id, e.id,
         (e.payload->'callback'->>'dueAt')::timestamptz,
         e.payload->'callback'->>'timezone',
         e.payload->'callback'->>'source',
         e.payload->'callback'->>'node',
         e.payload->>'disposition',
         e.payload->'callback'->>'reason'
       FROM ovo_session_events e
       WHERE e.workspace_id = $1 AND e.type = 'disposition' AND e.payload ? 'callback'
         AND e.payload->'callback'->>'source' IN ('flow', 'llm')
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
   * Claims a pending callback for dialling and returns what to dial it with. The operation id is
   * kept, so a dial retried after a failure is the same live call, never a second one.
   */
  async claimDial(
    workspaceId: string,
    id: string,
  ): Promise<CallbackDial | 'conflict' | 'unreachable' | undefined> {
    const claimed = await this.pool.query<{ dial_operation_id: string; call_id: string }>(
      `UPDATE ovo_callbacks SET status = 'dialing', updated_at = now(),
         dial_operation_id = COALESCE(dial_operation_id, $3::uuid)
       WHERE workspace_id = $1 AND id = $2 AND status = 'pending'
       RETURNING dial_operation_id, call_id`,
      [workspaceId, id, randomUUID()],
    );
    const row = claimed.rows[0];
    if (!row) return (await this.get(workspaceId, id)) ? 'conflict' : undefined;
    const job = await this.job(row.call_id);
    const dial = job ? dialFromJob(job) : undefined;
    if (!dial) {
      await this.transition(workspaceId, id, ['dialing'], 'pending');
      return 'unreachable';
    }
    return { operationId: row.dial_operation_id, ...dial };
  }

  async close(): Promise<void> {
    if (this.owned) await this.pool.end();
  }

  private async select(where: string, values: unknown[]): Promise<Row[]> {
    const jobs = await this.hasJobs();
    const result = await this.pool.query<Row>(
      `SELECT c.id, c.call_id, c.due_at, c.timezone, c.source, c.node, c.disposition, c.reason,
         c.status, c.dialed_call_id, c.created_at, c.updated_at,
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

/** The caller of an inbound call is called back from the number they dialled; outbound repeats. */
export function dialFromJob(
  job: Record<string, unknown>,
): Omit<CallbackDial, 'operationId'> | undefined {
  const text = (key: string) => (typeof job[key] === 'string' && job[key] ? job[key] : undefined);
  const releaseId = text('releaseId');
  const inbound = job.kind === 'inbound_call';
  const to = inbound ? text('from') : text('to');
  const fromNumber = inbound ? text('to') : text('from');
  if (!releaseId || !to || !fromNumber) return undefined;
  const raw = job.variables && typeof job.variables === 'object' ? job.variables : {};
  const variables = Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
      .map(([key, value]) => [key, String(value)]),
  );
  return { releaseId, to, fromNumber, variables };
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
    dialedCallId: row.dialed_call_id,
    phone: dial ? `••••${dial.to.slice(-4)}` : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
