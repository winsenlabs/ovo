-- Retain resumability only when the current job and worker slot still own the old route.
UPDATE ovo_session_routes r SET worker_slot_epoch = s.ownership_epoch
FROM ovo_worker_slots s, ovo_jobs j
WHERE r.worker_slot_epoch IS NULL AND s.worker_id = r.worker_id
  AND s.state IN ('reserved', 'active') AND s.lease_expires_at > now()
  AND j.id = r.job_id AND j.owner_id = r.worker_id AND j.owner_epoch = r.owner_epoch
  AND j.lease_expires_at > now()
  AND r.status IN ('dialing', 'accepted', 'connected') AND r.terminal_at IS NULL;

ALTER TABLE ovo_session_routes
  DROP CONSTRAINT IF EXISTS ovo_session_routes_dial_request_id_key,
  DROP CONSTRAINT IF EXISTS ovo_session_routes_carrier_call_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS ovo_session_routes_scope_dial_request_idx
  ON ovo_session_routes (organization_id, carrier_id, dial_request_id);
CREATE UNIQUE INDEX IF NOT EXISTS ovo_session_routes_scope_call_idx
  ON ovo_session_routes (organization_id, carrier_id, carrier_call_id)
  WHERE carrier_call_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ovo_session_routes_scope_stream_call_idx
  ON ovo_session_routes (organization_id, carrier_id, carrier_stream_call_id)
  WHERE carrier_stream_call_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ovo_session_routes_scope_request_idx
  ON ovo_session_routes (organization_id, carrier_id, carrier_request_id)
  WHERE carrier_request_id IS NOT NULL;
DROP INDEX IF EXISTS ovo_session_routes_stream_call_unique_idx;

ALTER TABLE ovo_carrier_callbacks
  ADD COLUMN IF NOT EXISTS organization_id text,
  ADD COLUMN IF NOT EXISTS carrier_id text;
UPDATE ovo_carrier_callbacks c SET organization_id = r.organization_id,
  carrier_id = r.carrier_id
FROM ovo_session_routes r WHERE r.session_id = c.session_id
  AND (c.organization_id IS NULL OR c.carrier_id IS NULL);
ALTER TABLE ovo_carrier_callbacks
  ALTER COLUMN organization_id SET NOT NULL,
  ALTER COLUMN carrier_id SET NOT NULL,
  DROP CONSTRAINT IF EXISTS ovo_carrier_callbacks_pkey;
ALTER TABLE ovo_carrier_callbacks
  ADD PRIMARY KEY (organization_id, carrier_id, provider, event_id);

CREATE TABLE IF NOT EXISTS ovo_orch_audit_events (
  session_id uuid NOT NULL REFERENCES ovo_session_routes(session_id) ON DELETE CASCADE,
  organization_id text NOT NULL,
  carrier_id text NOT NULL,
  event_type text NOT NULL,
  dial_call_id text NOT NULL,
  stream_call_id text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, event_type, stream_call_id)
);
