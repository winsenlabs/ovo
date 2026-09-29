ALTER TABLE ovo_ops_campaigns
  ADD COLUMN max_concurrency integer NOT NULL DEFAULT 1
    CHECK (max_concurrency BETWEEN 1 AND 1000);
ALTER TABLE ovo_ops_campaigns ADD COLUMN carrier_plugin_id text;
ALTER TABLE ovo_ops_campaigns ADD COLUMN carrier_id text;
ALTER TABLE ovo_ops_campaigns ADD COLUMN carrier_binding_id text;
ALTER TABLE ovo_ops_campaigns ADD COLUMN binding_cps numeric CHECK (binding_cps > 0);
ALTER TABLE ovo_ops_campaigns ADD COLUMN driver_error text;

CREATE TABLE ovo_ops_pacing_buckets (
  organization_id text NOT NULL,
  carrier_id text NOT NULL,
  binding_id text,
  from_number text NOT NULL,
  tokens numeric NOT NULL CHECK (tokens >= 0),
  refilled_at timestamptz NOT NULL,
  UNIQUE NULLS NOT DISTINCT (organization_id, carrier_id, binding_id, from_number)
);

ALTER TABLE ovo_ops_attempts DROP CONSTRAINT ovo_ops_attempts_status_check;
ALTER TABLE ovo_ops_attempts ADD CONSTRAINT ovo_ops_attempts_status_check CHECK (
  status IN ('authorized', 'dialing', 'connected', 'succeeded', 'failed', 'cancelled', 'unknown', 'superseded')
);

ALTER TABLE ovo_ops_campaign_contacts DROP CONSTRAINT ovo_ops_campaign_contacts_state_check;
ALTER TABLE ovo_ops_campaign_contacts ADD CONSTRAINT ovo_ops_campaign_contacts_state_check CHECK (
  state IN ('queued', 'admitted', 'dialing', 'active', 'succeeded', 'failed', 'cancelled', 'unknown', 'superseded', 'suppressed', 'exhausted')
);
