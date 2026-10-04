import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

const schemaV1 = `
CREATE TABLE ovo_recording_artifacts (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  call_id text NOT NULL,
  source text NOT NULL CHECK(source='carrier'),
  state text NOT NULL CHECK(state IN ('starting','active','paused','finalizing','available','partial','failed','expired')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  codec text NOT NULL CHECK(codec='audio/x-mulaw'),
  sample_rate integer NOT NULL CHECK(sample_rate=8000),
  channels integer NOT NULL CHECK(channels=2),
  segment_bytes integer NOT NULL CHECK(segment_bytes BETWEEN 65536 AND 8388608),
  failure text,
  UNIQUE(workspace_id, call_id, id)
);
CREATE INDEX ovo_recording_artifacts_call_idx ON ovo_recording_artifacts(workspace_id,call_id,created_at,id);
CREATE INDEX ovo_recording_artifacts_expiry_idx ON ovo_recording_artifacts(expires_at,id) WHERE state != 'expired';

CREATE TABLE ovo_recording_segments (
  artifact_id uuid NOT NULL REFERENCES ovo_recording_artifacts(id),
  track text NOT NULL CHECK(track IN ('inbound','outbound')),
  sequence integer NOT NULL CHECK(sequence>=0 AND sequence<10000),
  state text NOT NULL CHECK(state IN ('available','failed')),
  object_key text,
  sha256 text,
  bytes integer NOT NULL CHECK(bytes>=0),
  start_ms double precision NOT NULL CHECK(start_ms>=0),
  end_ms double precision NOT NULL CHECK(end_ms>=start_ms),
  timestamp_evidence text NOT NULL CHECK(timestamp_evidence IN ('provider-media-timestamp','worker-send-resolved')),
  error text,
  PRIMARY KEY(artifact_id,track,sequence),
  CHECK((state='available' AND object_key IS NOT NULL AND sha256 IS NOT NULL) OR state='failed')
);

CREATE TABLE ovo_recording_timeline (
  artifact_id uuid NOT NULL REFERENCES ovo_recording_artifacts(id),
  sequence integer NOT NULL CHECK(sequence>0 AND sequence<=20000),
  at_ms double precision NOT NULL CHECK(at_ms>=0),
  type text NOT NULL CHECK(type IN ('playback-sent','playback-mark-confirmed','speech-evidence')),
  evidence text NOT NULL,
  reference text NOT NULL,
  phase text,
  PRIMARY KEY(artifact_id,sequence)
);

CREATE TABLE ovo_recording_tombstones (
  artifact_id uuid PRIMARY KEY REFERENCES ovo_recording_artifacts(id),
  workspace_id text NOT NULL,
  call_id text NOT NULL,
  requested_at timestamptz NOT NULL,
  reason text NOT NULL CHECK(reason IN ('retention','operator')),
  cleanup_state text NOT NULL CHECK(cleanup_state IN ('pending','complete','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  last_error text,
  completed_at timestamptz
);
CREATE INDEX ovo_recording_tombstone_cleanup_idx ON ovo_recording_tombstones(cleanup_state,requested_at);

CREATE TABLE ovo_recording_cleanup_objects (
  artifact_id uuid NOT NULL REFERENCES ovo_recording_artifacts(id),
  object_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(artifact_id,object_key)
);

CREATE TABLE ovo_recording_exports (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  artifact_id uuid NOT NULL REFERENCES ovo_recording_artifacts(id),
  idempotency_key text NOT NULL,
  state text NOT NULL CHECK(state IN ('queued','running','succeeded','failed','cancelled')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  lease_owner text,
  lease_epoch integer NOT NULL DEFAULT 0 CHECK(lease_epoch>=0),
  lease_expires_at timestamptz,
  output_key text,
  output_sha256 text,
  output_bytes integer,
  error text,
  UNIQUE(workspace_id,idempotency_key)
);
CREATE INDEX ovo_recording_exports_claim_idx ON ovo_recording_exports(state,lease_expires_at,created_at);
`;

export async function runRecordingMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ovo-recording-migrations-v1'))");
    await client.query(`CREATE TABLE IF NOT EXISTS ovo_recording_schema_migrations(
      version integer PRIMARY KEY,name text NOT NULL,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const checksum = createHash('sha256').update(schemaV1).digest('hex');
    const existing = await client.query<{ checksum: string }>(
      'SELECT checksum FROM ovo_recording_schema_migrations WHERE version=1',
    );
    if (existing.rows[0] && existing.rows[0].checksum !== checksum)
      throw new Error('Recording migration checksum mismatch');
    if (!existing.rows[0]) {
      await client.query(schemaV1);
      await client.query(
        'INSERT INTO ovo_recording_schema_migrations(version,name,checksum) VALUES(1,$1,$2)',
        ['recording-artifacts', checksum],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
