CREATE TABLE IF NOT EXISTS ovo_jobs (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN (
    'queued', 'owned', 'dialing', 'reconcile_required', 'accepted',
    'connected', 'completed', 'failed', 'cancelled'
  )),
  owner_id text,
  owner_epoch bigint NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  dial_request_id text,
  carrier_call_id text,
  last_error text,
  not_before timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS ovo_jobs_eligible_idx
  ON ovo_jobs (not_before, created_at)
  WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS ovo_job_attempts (
  job_id uuid NOT NULL REFERENCES ovo_jobs(id) ON DELETE CASCADE,
  epoch bigint NOT NULL,
  worker_id text NOT NULL,
  state text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (job_id, epoch)
);

CREATE TABLE IF NOT EXISTS ovo_outbox (
  id uuid PRIMARY KEY,
  topic text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  publishing_by text,
  publishing_until timestamptz,
  sent_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);

CREATE INDEX IF NOT EXISTS ovo_outbox_pending_idx
  ON ovo_outbox (created_at)
  WHERE sent_at IS NULL;

CREATE TABLE IF NOT EXISTS ovo_capacity_leases (
  service_key text PRIMARY KEY,
  authority_id text NOT NULL,
  epoch bigint NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ovo_worker_slots (
  worker_id text PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('ready_idle', 'reserved', 'active', 'starting', 'draining')),
  ownership_epoch bigint NOT NULL DEFAULT 0,
  observed_at timestamptz NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS ovo_worker_slots_state_idx
  ON ovo_worker_slots (state, lease_expires_at);
