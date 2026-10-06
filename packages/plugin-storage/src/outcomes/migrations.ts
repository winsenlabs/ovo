import type { Pool } from 'pg';
import { transaction } from '../postgres/shared.ts';

/**
 * v1 (AGT-8): the per-call session event log and the outcome summary folded from it. Neither has a
 * foreign key to `ovo_ctl_calls`: the worker writes outcomes from its own small pool while the call
 * row is owned by the control store, and the API only reads outcomes for calls it has already found.
 */
export const callOutcomesV1 = `
CREATE TABLE IF NOT EXISTS ovo_session_events (
  workspace_id text NOT NULL CHECK (length(workspace_id) > 0),
  call_id text NOT NULL CHECK (length(call_id) BETWEEN 1 AND 200),
  sequence integer NOT NULL CHECK (sequence > 0),
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 100),
  at timestamptz NOT NULL,
  type text NOT NULL CHECK (length(type) BETWEEN 1 AND 100),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  PRIMARY KEY (workspace_id, call_id, sequence),
  UNIQUE (workspace_id, call_id, id)
);

CREATE TABLE IF NOT EXISTS ovo_call_outcomes (
  workspace_id text NOT NULL CHECK (length(workspace_id) > 0),
  call_id text NOT NULL CHECK (length(call_id) BETWEEN 1 AND 200),
  outcome text,
  end_reason text,
  disposition text,
  disposition_source text,
  final_node text,
  state_path jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(state_path) = 'array'),
  variables jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(variables) = 'object'),
  tiers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(tiers) = 'object'),
  guardrail_flagged integer NOT NULL DEFAULT 0 CHECK (guardrail_flagged >= 0),
  guardrail_blocked integer NOT NULL DEFAULT 0 CHECK (guardrail_blocked >= 0),
  events integer NOT NULL DEFAULT 0 CHECK (events >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, call_id)
);
`;

/** Applied in order; a migration's version is its position, starting at 1. */
const MIGRATIONS: readonly string[] = [callOutcomesV1];

/** Idempotent and safe to race: the API and every worker run it on startup. */
export async function runCallOutcomeMigrations(pool: Pool): Promise<void> {
  await transaction(pool, async (client) => {
    // A racing worker waits for the first one here, so its statement timeout must not apply.
    await client.query(
      "SET LOCAL statement_timeout = 0; SELECT pg_advisory_xact_lock(hashtext('ovo-call-outcome-migrations'));" +
        ' CREATE TABLE IF NOT EXISTS ovo_outcome_schema_migrations' +
        ' (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const applied = await client.query<{ version: number }>(
      'SELECT version FROM ovo_outcome_schema_migrations',
    );
    const done = new Set(applied.rows.map((row) => Number(row.version)));
    for (let version = 1; version <= MIGRATIONS.length; version += 1) {
      if (done.has(version)) continue;
      await client.query(MIGRATIONS[version - 1]!);
      await client.query('INSERT INTO ovo_outcome_schema_migrations (version) VALUES ($1)', [
        version,
      ]);
    }
  });
}
