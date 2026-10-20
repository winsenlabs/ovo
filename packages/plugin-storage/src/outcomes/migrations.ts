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

/** v2 (Wave 15): a routed call's route, folded from `route.decision` and `route.segment`. */
export const callOutcomesV2 = `
ALTER TABLE ovo_call_outcomes ADD COLUMN IF NOT EXISTS route jsonb
  CHECK (route IS NULL OR jsonb_typeof(route) = 'object');
`;

/**
 * v3 (Wave 16): every segment of a routed call and the call's transfer counts. `transfers` stays
 * NULL for a call without transfer events and reads as zeros.
 */
export const callOutcomesV3 = `
ALTER TABLE ovo_call_outcomes
  ADD COLUMN IF NOT EXISTS segments jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(segments) = 'array'),
  ADD COLUMN IF NOT EXISTS transfers jsonb
    CHECK (transfers IS NULL OR jsonb_typeof(transfers) = 'object');
`;

/**
 * v4 (Wave 17): a call's human queue handoff, folded from `human.*` events (third-party callbacks
 * included, whenever they arrive). Additive and nullable; take a backup before deploy.
 */
export const callOutcomesV4 = `
ALTER TABLE ovo_call_outcomes ADD COLUMN IF NOT EXISTS human jsonb
  CHECK (human IS NULL OR jsonb_typeof(human) = 'object');
`;

/**
 * v5 (Wave 18): the routed-call reads of the console. Three indexes, nothing else: newest first
 * per workspace (the calls filter cursor), a routed call's point (filter and stats), and the
 * segments (an agent or pool that took part). Additive; take a backup before deploy.
 */
export const callOutcomesV5 = `
CREATE INDEX IF NOT EXISTS ovo_call_outcomes_updated_idx
  ON ovo_call_outcomes (workspace_id, updated_at DESC, call_id DESC);
CREATE INDEX IF NOT EXISTS ovo_call_outcomes_route_point_idx
  ON ovo_call_outcomes (workspace_id, (route->>'routingPointId'), updated_at DESC)
  WHERE route IS NOT NULL;
CREATE INDEX IF NOT EXISTS ovo_call_outcomes_segments_idx
  ON ovo_call_outcomes USING gin (segments jsonb_path_ops);
`;

/** Applied in order; a migration's version is its position, starting at 1. */
const MIGRATIONS: readonly string[] = [
  callOutcomesV1,
  callOutcomesV2,
  callOutcomesV3,
  callOutcomesV4,
  callOutcomesV5,
];

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
