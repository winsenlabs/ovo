ALTER TABLE ovo_jobs
  ADD COLUMN IF NOT EXISTS carrier_id text NOT NULL DEFAULT 'twilio',
  ADD COLUMN IF NOT EXISTS binding_id text,
  ADD COLUMN IF NOT EXISTS carrier_request_id text;

ALTER TABLE ovo_session_routes
  ADD COLUMN IF NOT EXISTS carrier_id text NOT NULL DEFAULT 'twilio',
  ADD COLUMN IF NOT EXISTS binding_id text,
  ADD COLUMN IF NOT EXISTS carrier_request_id text,
  ADD COLUMN IF NOT EXISTS carrier_stream_call_id text,
  ADD COLUMN IF NOT EXISTS worker_slot_epoch bigint;

ALTER TABLE ovo_carrier_callbacks ALTER COLUMN carrier_call_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS ovo_session_routes_carrier_call_idx
  ON ovo_session_routes (carrier_id, carrier_call_id);

CREATE INDEX IF NOT EXISTS ovo_session_routes_carrier_request_idx
  ON ovo_session_routes (carrier_request_id);

CREATE UNIQUE INDEX IF NOT EXISTS ovo_session_routes_stream_call_unique_idx
  ON ovo_session_routes (carrier_stream_call_id)
  WHERE carrier_stream_call_id IS NOT NULL;
