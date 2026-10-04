CREATE TABLE IF NOT EXISTS ovo_ops_inbound_routes (
  organization_id text NOT NULL,
  phone_number text NOT NULL,
  release_id uuid NOT NULL,
  variables jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, phone_number)
);

ALTER TABLE ovo_ops_inbound_capacity
  ADD COLUMN IF NOT EXISTS worker_endpoint text;

ALTER TABLE ovo_ops_inbound_admissions
  ADD COLUMN IF NOT EXISTS from_number text,
  ADD COLUMN IF NOT EXISTS to_number text,
  ADD COLUMN IF NOT EXISTS route_version bigint,
  ADD COLUMN IF NOT EXISTS release_id uuid,
  ADD COLUMN IF NOT EXISTS variables jsonb,
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS session_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS ovo_ops_inbound_admissions_job_unique_idx
  ON ovo_ops_inbound_admissions (job_id) WHERE job_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ovo_ops_inbound_admissions_session_unique_idx
  ON ovo_ops_inbound_admissions (session_id) WHERE session_id IS NOT NULL;
