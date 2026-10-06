-- Collections compliance (Wave 5): a campaign's calling-hours window and the release's variable
-- schema are snapshotted at create; NULL keeps a campaign created before this migration unchanged.
ALTER TABLE ovo_ops_campaigns ADD COLUMN calling_window jsonb;
ALTER TABLE ovo_ops_campaigns ADD COLUMN variables_schema jsonb;

-- A contact whose variables fail the release schema at admission is never dialed.
ALTER TABLE ovo_ops_campaign_contacts DROP CONSTRAINT ovo_ops_campaign_contacts_state_check;
ALTER TABLE ovo_ops_campaign_contacts ADD CONSTRAINT ovo_ops_campaign_contacts_state_check CHECK (
  state IN ('queued', 'admitted', 'dialing', 'active', 'succeeded', 'failed', 'cancelled', 'unknown', 'superseded', 'suppressed', 'exhausted', 'invalid')
);

-- The suppression list is the do-not-call list: where each entry came from, and the call in which
-- a caller opted out.
ALTER TABLE ovo_ops_suppressions ADD COLUMN source text NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual', 'import', 'opt_out'));
ALTER TABLE ovo_ops_suppressions ADD COLUMN call_id text;
ALTER TABLE ovo_ops_suppressions ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
