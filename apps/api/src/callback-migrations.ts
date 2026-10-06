import type { Pool, PoolClient } from 'pg';
import { transaction } from '@winsendotai/ovo-plugin-kit/postgres-transaction';
import { runCallOutcomeMigrations } from '@winsendotai/ovo-plugin-storage/outcomes';

/**
 * Callback schema v1 (AGT-15). A callback is promised during a call as a `disposition` session
 * event carrying a `callback` field; `ovo_callbacks` adds what happens to it afterwards. The partial
 * index keeps the sync from scanning every session event: only callback dispositions enter it.
 */
const V1 = [
  `CREATE TABLE IF NOT EXISTS ovo_callbacks (
     id uuid PRIMARY KEY,
     workspace_id text NOT NULL,
     call_id text NOT NULL,
     event_id text NOT NULL,
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
     UNIQUE (workspace_id, call_id, event_id))`,
  'CREATE INDEX IF NOT EXISTS ovo_callbacks_due ON ovo_callbacks (workspace_id, status, due_at, id)',
  `CREATE INDEX IF NOT EXISTS ovo_session_events_callbacks ON ovo_session_events (workspace_id)
     WHERE type = 'disposition' AND payload ? 'callback'`,
];

/** Versions in order; a version's statements run in one transaction with its ledger row. */
const VERSIONS: readonly (readonly string[])[] = [V1];

/**
 * Runs on the API's first callback read, after the outcome schema it indexes. Safe when several
 * API processes start at once: the advisory lock serialises them and an applied version is skipped.
 */
export async function runCallbackMigrations(pool: Pool): Promise<void> {
  await runCallOutcomeMigrations(pool);
  await transaction<PoolClient, void>(pool, async (client) => {
    await client.query(
      "SET LOCAL statement_timeout = 0; SELECT pg_advisory_xact_lock(hashtext('ovo-callback-migrations'))",
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS ovo_callback_schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const { rows } = await client.query<{ version: number }>(
      'SELECT version FROM ovo_callback_schema_migrations',
    );
    const applied = new Set(rows.map((row) => Number(row.version)));
    for (const [index, statements] of VERSIONS.entries()) {
      if (applied.has(index + 1)) continue;
      for (const statement of statements) await client.query(statement);
      await client.query('INSERT INTO ovo_callback_schema_migrations (version) VALUES ($1)', [
        index + 1,
      ]);
    }
  });
}
