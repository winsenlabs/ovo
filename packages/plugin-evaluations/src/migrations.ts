import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

const SQL = `
CREATE TABLE IF NOT EXISTS ovo_eval_datasets (
  workspace_id text NOT NULL, id text NOT NULL, name text NOT NULL, description text NOT NULL,
  current_version integer NOT NULL DEFAULT 0 CHECK(current_version >= 0), archived_at timestamptz,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS ovo_eval_dataset_versions (
  workspace_id text NOT NULL, dataset_id text NOT NULL, version integer NOT NULL CHECK(version > 0),
  fingerprint text NOT NULL, cases jsonb NOT NULL CHECK(jsonb_typeof(cases)='array'),
  created_at timestamptz NOT NULL, created_by text NOT NULL,
  PRIMARY KEY(workspace_id,dataset_id,version), UNIQUE(workspace_id,dataset_id,fingerprint),
  FOREIGN KEY(workspace_id,dataset_id) REFERENCES ovo_eval_datasets(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS ovo_eval_runs (
  workspace_id text NOT NULL, id text NOT NULL, dataset_id text NOT NULL, dataset_version integer NOT NULL,
  dataset_fingerprint text NOT NULL, release_id text NOT NULL, release_fingerprint text NOT NULL,
  fixture_binding_version text NOT NULL, executor_kind text NOT NULL CHECK(executor_kind IN ('fixture','provider')),
  idempotency_key text NOT NULL, status text NOT NULL CHECK(status IN ('queued','running','cancelling','cancelled','succeeded','failed')),
  attempt integer NOT NULL DEFAULT 0 CHECK(attempt >= 0), max_attempts integer NOT NULL CHECK(max_attempts BETWEEN 1 AND 5),
  owner_id text, owner_epoch bigint NOT NULL DEFAULT 0, lease_expires_at timestamptz,
  passed integer NOT NULL DEFAULT 0, failed integer NOT NULL DEFAULT 0, total integer NOT NULL CHECK(total >= 0),
  error text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, completed_at timestamptz,
  PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,idempotency_key),
  FOREIGN KEY(workspace_id,dataset_id,dataset_version) REFERENCES ovo_eval_dataset_versions(workspace_id,dataset_id,version)
);
CREATE INDEX IF NOT EXISTS ovo_eval_runs_claim_idx ON ovo_eval_runs(status,lease_expires_at,created_at);
CREATE INDEX IF NOT EXISTS ovo_eval_runs_list_idx ON ovo_eval_runs(workspace_id,created_at,id);
CREATE TABLE IF NOT EXISTS ovo_eval_case_results (
  workspace_id text NOT NULL, run_id text NOT NULL, case_id text NOT NULL, mode text NOT NULL,
  passed boolean NOT NULL, outputs jsonb NOT NULL, error text, operations jsonb NOT NULL,
  duration_ms integer NOT NULL CHECK(duration_ms >= 0), created_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,run_id,case_id),
  FOREIGN KEY(workspace_id,run_id) REFERENCES ovo_eval_runs(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ovo_eval_results_page_idx ON ovo_eval_case_results(workspace_id,run_id,case_id);
`;

const PROVIDER_SQL = `
ALTER TABLE ovo_eval_runs ADD COLUMN IF NOT EXISTS budget_authorization_id text;
ALTER TABLE ovo_eval_case_results ADD COLUMN IF NOT EXISTS provenance jsonb NOT NULL DEFAULT '{}'::jsonb;
`;

export async function migrateEvaluations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ovo-evaluations-migrations-v1'))");
    await client.query(`CREATE TABLE IF NOT EXISTS ovo_eval_schema_migrations(
      version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const migration of [
      { version: 1, sql: SQL },
      { version: 2, sql: PROVIDER_SQL },
    ]) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      const current = await client.query<{ checksum: string }>(
        'SELECT checksum FROM ovo_eval_schema_migrations WHERE version=$1',
        [migration.version],
      );
      if (current.rowCount && current.rows[0]!.checksum !== checksum)
        throw new Error(`Evaluation migration ${migration.version} checksum mismatch`);
      if (current.rowCount) continue;
      await executeStatements(client, migration.sql);
      await client.query('INSERT INTO ovo_eval_schema_migrations(version,checksum) VALUES($1,$2)', [
        migration.version,
        checksum,
      ]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function executeStatements(client: PoolClient, sql: string) {
  for (const statement of sql
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean))
    await client.query(statement);
}
