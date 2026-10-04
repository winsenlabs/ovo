CREATE TABLE IF NOT EXISTS ovo_session_routes (
  session_id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE REFERENCES ovo_jobs(id) ON DELETE CASCADE,
  organization_id text NOT NULL,
  worker_id text NOT NULL,
  worker_endpoint text NOT NULL,
  owner_epoch bigint NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  dial_request_id text NOT NULL UNIQUE,
  carrier_call_id text UNIQUE,
  status text NOT NULL CHECK (status IN (
    'dialing', 'accepted', 'connected', 'terminating', 'completed', 'failed', 'cancelled'
  )),
  handshake_token_hash text NOT NULL,
  handshake_expires_at timestamptz NOT NULL,
  handshake_claimed_at timestamptz,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  connected_at timestamptz,
  terminal_at timestamptz,
  terminal_reason text,
  released_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, owner_epoch, generation)
);

CREATE INDEX IF NOT EXISTS ovo_session_routes_unreleased_idx
  ON ovo_session_routes (updated_at)
  WHERE terminal_at IS NOT NULL AND released_at IS NULL;

CREATE TABLE IF NOT EXISTS ovo_carrier_callbacks (
  provider text NOT NULL,
  event_id text NOT NULL,
  session_id uuid NOT NULL REFERENCES ovo_session_routes(session_id) ON DELETE CASCADE,
  dial_request_id text,
  carrier_call_id text NOT NULL,
  status text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (provider, event_id)
);

CREATE INDEX IF NOT EXISTS ovo_carrier_callbacks_session_idx
  ON ovo_carrier_callbacks (session_id, occurred_at, received_at);
