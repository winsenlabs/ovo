import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

const migration = `
CREATE TABLE IF NOT EXISTS ovo_telemetry_events (
  schema_version integer NOT NULL CHECK (schema_version = 1),
  workspace_id text NOT NULL,
  call_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  event_id text NOT NULL,
  event_hash bytea NOT NULL,
  occurred_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  source text NOT NULL CHECK (source IN ('live', 'simulation')),
  kind text NOT NULL,
  agent_id text,
  release_id text,
  provider text,
  model text,
  language text,
  turn_id text,
  response_epoch bigint,
  stage_id text,
  stage text,
  operation_id text,
  segment_id text,
  duration_ms double precision CHECK (duration_ms >= 0),
  outcome text,
  evidence text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, call_id, sequence),
  UNIQUE (workspace_id, event_id)
);
CREATE INDEX IF NOT EXISTS ovo_telemetry_events_call_time_idx
  ON ovo_telemetry_events (workspace_id, call_id, occurred_at, sequence);
CREATE INDEX IF NOT EXISTS ovo_telemetry_events_retention_idx
  ON ovo_telemetry_events (occurred_at, workspace_id, call_id);

CREATE TABLE IF NOT EXISTS ovo_telemetry_calls (
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  workspace_id text NOT NULL,
  call_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('live', 'simulation')),
  agent_id text,
  release_id text,
  language text,
  first_at timestamptz NOT NULL,
  last_at timestamptz NOT NULL,
  last_sequence bigint NOT NULL,
  event_count bigint NOT NULL,
  gap_detected boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  PRIMARY KEY (workspace_id, call_id)
);

CREATE TABLE IF NOT EXISTS ovo_telemetry_stages (
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  workspace_id text NOT NULL,
  call_id text NOT NULL,
  stage_id text NOT NULL,
  stage text NOT NULL,
  source text NOT NULL CHECK (source IN ('live', 'simulation')),
  agent_id text,
  release_id text,
  provider text,
  model text,
  language text,
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms double precision CHECK (duration_ms >= 0),
  outcome text NOT NULL,
  updated_sequence bigint NOT NULL,
  PRIMARY KEY (workspace_id, call_id, stage_id)
);
CREATE INDEX IF NOT EXISTS ovo_telemetry_stages_performance_idx
  ON ovo_telemetry_stages
  (workspace_id, (COALESCE(finished_at, started_at)), stage, source, agent_id, release_id);

CREATE TABLE IF NOT EXISTS ovo_telemetry_playback (
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  workspace_id text NOT NULL,
  call_id text NOT NULL,
  segment_id text NOT NULL,
  response_epoch bigint,
  speech_kind text,
  generated_at timestamptz,
  queued_at timestamptz,
  started_at timestamptz,
  sent_at timestamptz,
  acknowledged_at timestamptz,
  completed_at timestamptz,
  terminal_state text,
  evidence text,
  updated_sequence bigint NOT NULL,
  PRIMARY KEY (workspace_id, call_id, segment_id)
);

CREATE TABLE IF NOT EXISTS ovo_telemetry_operations (
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  workspace_id text NOT NULL,
  call_id text NOT NULL,
  operation_id text NOT NULL,
  tool_id text,
  state text NOT NULL,
  started_at timestamptz,
  settled_at timestamptz,
  updated_sequence bigint NOT NULL,
  PRIMARY KEY (workspace_id, call_id, operation_id)
);
`;

export async function migrateTelemetry(client: PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [1_513_504_015]);
  await client.query(`CREATE TABLE IF NOT EXISTS ovo_telemetry_schema_migrations (
    version integer PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )`);
  const checksum = createHash('sha256').update(migration).digest('hex');
  const current = await client.query<{ checksum: string }>(
    'SELECT checksum FROM ovo_telemetry_schema_migrations WHERE version=1',
  );
  if (current.rows[0] && current.rows[0].checksum !== checksum)
    throw new Error('Telemetry migration checksum mismatch');
  if (current.rows[0]) return;
  await client.query(migration);
  await client.query(
    'INSERT INTO ovo_telemetry_schema_migrations(version, checksum) VALUES (1, $1)',
    [checksum],
  );
}
