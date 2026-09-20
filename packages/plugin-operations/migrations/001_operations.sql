CREATE TABLE IF NOT EXISTS ovo_ops_campaigns (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  operation_id text NOT NULL,
  input_digest text NOT NULL,
  name text NOT NULL,
  agent_release_id text NOT NULL,
  from_number text NOT NULL,
  status text NOT NULL CHECK (status IN ('scheduled', 'running', 'paused', 'cancelled', 'completed')),
  schedule_at timestamptz NOT NULL,
  timezone text NOT NULL,
  per_number_attempt_limit integer NOT NULL CHECK (per_number_attempt_limit BETWEEN 1 AND 100),
  max_attempts_total integer NOT NULL CHECK (max_attempts_total BETWEEN 1 AND 10000000),
  max_attempts_per_local_day integer NOT NULL CHECK (max_attempts_per_local_day BETWEEN 1 AND 10000000),
  active_call_policy text NOT NULL CHECK (active_call_policy IN ('continue', 'request_end')),
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, operation_id)
);

CREATE INDEX IF NOT EXISTS ovo_ops_campaigns_org_status_idx
  ON ovo_ops_campaigns (organization_id, status, schedule_at, id);

CREATE TABLE IF NOT EXISTS ovo_ops_campaign_contacts (
  id uuid PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES ovo_ops_campaigns(id) ON DELETE CASCADE,
  source_row integer NOT NULL CHECK (source_row > 0),
  phone_number text NOT NULL,
  external_id text,
  variables jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'queued' CHECK (
    state IN ('queued', 'admitted', 'dialing', 'active', 'succeeded', 'failed', 'cancelled', 'unknown', 'suppressed', 'exhausted')
  ),
  owner_id text,
  owner_epoch bigint NOT NULL DEFAULT 0,
  admission_campaign_version bigint,
  lease_expires_at timestamptz,
  not_before timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, phone_number)
);

CREATE INDEX IF NOT EXISTS ovo_ops_contacts_admission_idx
  ON ovo_ops_campaign_contacts (campaign_id, state, not_before, source_row, id);

CREATE TABLE IF NOT EXISTS ovo_ops_suppressions (
  organization_id text NOT NULL,
  phone_number text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, phone_number)
);

CREATE TABLE IF NOT EXISTS ovo_ops_attempts (
  id uuid PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES ovo_ops_campaigns(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES ovo_ops_campaign_contacts(id) ON DELETE CASCADE,
  request_id text NOT NULL UNIQUE,
  sequence integer NOT NULL CHECK (sequence > 0),
  status text NOT NULL CHECK (
    status IN ('authorized', 'dialing', 'connected', 'succeeded', 'failed', 'cancelled', 'unknown')
  ),
  terminal_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contact_id, sequence)
);

CREATE INDEX IF NOT EXISTS ovo_ops_attempts_campaign_created_idx
  ON ovo_ops_attempts (campaign_id, created_at, status);

CREATE TABLE IF NOT EXISTS ovo_ops_attempt_events (
  event_id text PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES ovo_ops_attempts(id) ON DELETE CASCADE,
  status text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ovo_ops_outbox (
  id uuid PRIMARY KEY,
  topic text NOT NULL,
  aggregate_id uuid NOT NULL,
  dedup_key text NOT NULL,
  payload jsonb NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_by text,
  claim_expires_at timestamptz,
  sent_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (topic, dedup_key)
);

CREATE INDEX IF NOT EXISTS ovo_ops_outbox_dispatch_idx
  ON ovo_ops_outbox (sent_at, available_at, claim_expires_at, created_at);

CREATE TABLE IF NOT EXISTS ovo_ops_inbound_capacity (
  slot_id text PRIMARY KEY,
  organization_id text NOT NULL,
  worker_id text NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  ready boolean NOT NULL,
  protected_until timestamptz NOT NULL,
  reservation_id uuid,
  reserved_call_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ovo_ops_inbound_ready_idx
  ON ovo_ops_inbound_capacity (organization_id, ready, protected_until, slot_id)
  WHERE reservation_id IS NULL;

CREATE TABLE IF NOT EXISTS ovo_ops_inbound_admissions (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  call_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('reserved', 'busy', 'wait', 'callback', 'human')),
  slot_id text REFERENCES ovo_ops_inbound_capacity(slot_id),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, call_id)
);

CREATE TABLE IF NOT EXISTS ovo_ops_inbound_policy (
  organization_id text PRIMARY KEY,
  policy jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ovo_ops_call_bindings (
  organization_id text NOT NULL,
  internal_call_id text NOT NULL,
  carrier_call_id text NOT NULL,
  release_id text NOT NULL,
  binding_receipt_id text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'terminal')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, internal_call_id),
  UNIQUE (organization_id, carrier_call_id)
);

CREATE TABLE IF NOT EXISTS ovo_ops_handoffs (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  operation_id text NOT NULL,
  input_digest text NOT NULL,
  session_id text NOT NULL,
  carrier_call_id text NOT NULL,
  target jsonb NOT NULL,
  fallback jsonb NOT NULL,
  status text NOT NULL CHECK (status IN (
    'awaiting_confirmation', 'ready', 'submitting', 'confirmed', 'failed', 'unknown',
    'cancelled', 'fallback_submitting', 'fallback_completed', 'fallback_failed', 'fallback_unknown'
  )),
  attempt integer NOT NULL DEFAULT 0,
  request_id text,
  fallback_attempt integer NOT NULL DEFAULT 0,
  fallback_request_id text,
  provider_receipt_id text,
  retryable boolean NOT NULL DEFAULT false,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, operation_id)
);

CREATE INDEX IF NOT EXISTS ovo_ops_handoffs_session_idx
  ON ovo_ops_handoffs (organization_id, session_id, created_at DESC);
