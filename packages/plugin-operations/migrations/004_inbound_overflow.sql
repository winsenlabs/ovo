ALTER TABLE ovo_ops_inbound_admissions
  ADD COLUMN IF NOT EXISTS wait_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS callback_campaign_id uuid REFERENCES ovo_ops_campaigns(id),
  ADD COLUMN IF NOT EXISTS callback_contact_id uuid REFERENCES ovo_ops_campaign_contacts(id),
  ADD COLUMN IF NOT EXISTS callback_job_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS ovo_ops_inbound_callback_campaign_unique_idx
  ON ovo_ops_inbound_admissions (callback_campaign_id)
  WHERE callback_campaign_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ovo_ops_inbound_callback_contact_unique_idx
  ON ovo_ops_inbound_admissions (callback_contact_id)
  WHERE callback_contact_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ovo_ops_inbound_callback_job_unique_idx
  ON ovo_ops_inbound_admissions (callback_job_id)
  WHERE callback_job_id IS NOT NULL;
