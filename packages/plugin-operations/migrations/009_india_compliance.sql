-- India outbound compliance by configuration (TRAI TCCCPR, RBI recovery rules). Compliance
-- spec 3.3. Records here are evidence: nothing references a campaign, so deleting a campaign
-- never deletes what was decided about its calls (keep at least 2 years, R22).

CREATE TABLE ovo_ops_compliance_settings (
  organization_id text PRIMARY KEY,
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The CLI registry (G2): which caller numbers may place which category of call.
CREATE TABLE ovo_ops_cli_numbers (
  organization_id text NOT NULL,
  phone_number text NOT NULL,
  series text NOT NULL CHECK (series IN ('140', '1600', '1601', 'other')),
  categories text[] NOT NULL CHECK (categories <@ ARRAY['promotional', 'service', 'transactional']),
  dlt_entity_id text,
  oap text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'flagged', 'retired')),
  flagged_at timestamptz,
  flag_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, phone_number)
);

-- A2P declarations to the originating telco (R7): CLI ranges and when each takes effect.
CREATE TABLE ovo_ops_a2p_declarations (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  range_start text NOT NULL,
  range_end text NOT NULL CHECK (length(range_end) = length(range_start) AND range_end >= range_start),
  oap text NOT NULL,
  reference text NOT NULL,
  declared_at date NOT NULL,
  effective_from date NOT NULL,
  withdrawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ovo_ops_a2p_declarations_org ON ovo_ops_a2p_declarations (organization_id);

-- The consent ledger (G7, R9-R13).
CREATE TABLE ovo_ops_consents (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  phone_number text NOT NULL,
  principal_entity text NOT NULL,
  purpose text NOT NULL,
  category text NOT NULL CHECK (category IN ('promotional', 'service', 'transactional')),
  basis text NOT NULL CHECK (basis IN ('explicit_registered', 'explicit_legacy_registered',
    'explicit_service_7d', 'inferred_relationship', 'inquiry_7d', 'application_3m', 'transaction_30min')),
  evidence_ref text NOT NULL CHECK (length(evidence_ref) > 0),
  customer_initiated boolean NOT NULL DEFAULT false,
  obtained_at timestamptz NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  revocation_source text CHECK (revocation_source IN ('in_call_opt_out', 'dlt', 'manual', 'complaint')),
  revocation_ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ovo_ops_consents_lookup ON ovo_ops_consents (organization_id, phone_number, category);

-- Do-not-call entries gain a scope, a purpose and an immutability window (G6, R13).
ALTER TABLE ovo_ops_suppressions ADD COLUMN scope text NOT NULL DEFAULT 'all'
  CHECK (scope IN ('all', 'promotional', 'purpose'));
ALTER TABLE ovo_ops_suppressions ADD COLUMN purpose text;
ALTER TABLE ovo_ops_suppressions ADD COLUMN lock_until timestamptz;
ALTER TABLE ovo_ops_suppressions DROP CONSTRAINT ovo_ops_suppressions_source_check;
ALTER TABLE ovo_ops_suppressions ADD CONSTRAINT ovo_ops_suppressions_source_check CHECK (
  source IN ('manual', 'import', 'opt_out', 'ncpr', 'dlt_revocation', 'complaint', 'wrong_number', 'regulator')
);
-- Opt-outs recorded before this migration keep the 90-day lock from when they were made.
UPDATE ovo_ops_suppressions SET lock_until = created_at + interval '90 days' WHERE source = 'opt_out';

-- DND / NCPR scrub results (G8, R14).
CREATE TABLE ovo_ops_preference_checks (
  organization_id text NOT NULL,
  phone_number text NOT NULL,
  provider text NOT NULL,
  result text NOT NULL CHECK (result IN ('allowed', 'blocked', 'fully_blocked', 'unknown')),
  blocked_categories integer[],
  blocked_time_bands integer[],
  blocked_day_types integer[],
  checked_at timestamptz NOT NULL,
  provider_ref text,
  PRIMARY KEY (organization_id, phone_number, provider)
);

-- One row per authorized attempt, org-wide (G9): per-recipient caps, CLI velocity and the
-- abandoned/silent ratios read it; dispositions are folded in after the call.
CREATE TABLE ovo_ops_recipient_attempts (
  organization_id text NOT NULL,
  attempt_id uuid NOT NULL,
  phone_number text NOT NULL,
  from_number text NOT NULL,
  category text,
  purpose text,
  campaign_id uuid,
  contact_id uuid,
  call_id text,
  authorized_at timestamptz NOT NULL,
  connected_at timestamptz,
  ended_at timestamptz,
  terminal_status text,
  outcome text,
  disposition text,
  disposition_checked_at timestamptz,
  PRIMARY KEY (organization_id, attempt_id)
);
CREATE INDEX ovo_ops_recipient_attempts_phone
  ON ovo_ops_recipient_attempts (organization_id, phone_number, authorized_at DESC);
CREATE INDEX ovo_ops_recipient_attempts_cli
  ON ovo_ops_recipient_attempts (organization_id, from_number, authorized_at DESC);
CREATE INDEX ovo_ops_recipient_attempts_pending_disposition
  ON ovo_ops_recipient_attempts (organization_id, ended_at)
  WHERE ended_at IS NOT NULL AND disposition_checked_at IS NULL;

-- Every compliance decision (G15), written in the same transaction as what it decided.
CREATE TABLE ovo_ops_compliance_decisions (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  stage text NOT NULL CHECK (stage IN ('create', 'admit', 'authorize', 'manual', 'redrive', 'post_call')),
  campaign_id uuid,
  contact_id uuid,
  attempt_id uuid,
  phone_number text NOT NULL,
  from_number text,
  category text,
  rule_pack text NOT NULL,
  policy_hash text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('allow', 'refuse', 'defer')),
  reason text,
  warnings text[] NOT NULL DEFAULT '{}',
  bypass text,
  consent_id uuid,
  preference_check_ref text,
  window_effective jsonb,
  caps_snapshot jsonb,
  details jsonb,
  next_eligible_at timestamptz
);
CREATE INDEX ovo_ops_compliance_decisions_time
  ON ovo_ops_compliance_decisions (organization_id, decided_at);
CREATE INDEX ovo_ops_compliance_decisions_phone
  ON ovo_ops_compliance_decisions (organization_id, phone_number, decided_at);

-- Complaints and telco or regulator notices (G14, R21-R22), with their SLA deadlines.
CREATE TABLE ovo_ops_complaints (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('customer', 'oap_notice', 'ai_flag_notice', 'appeal', 'regulator')),
  phone_number text,
  cli text,
  call_id text,
  received_at timestamptz NOT NULL,
  channel text,
  oap_ref text,
  summary text,
  ack_due_at timestamptz,
  resolve_due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'represented', 'resolved', 'closed')),
  acknowledged_at timestamptz,
  resolution text,
  resolved_at timestamptz,
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ovo_ops_complaints_open ON ovo_ops_complaints (organization_id, phone_number)
  WHERE status IN ('open', 'acknowledged', 'represented');

-- A campaign snapshots its compliance policy; a contact refused by it records why.
ALTER TABLE ovo_ops_campaigns ADD COLUMN compliance_policy jsonb;
ALTER TABLE ovo_ops_campaigns ADD COLUMN category text;
ALTER TABLE ovo_ops_campaigns ADD COLUMN purpose text;
ALTER TABLE ovo_ops_campaign_contacts ADD COLUMN compliance_reason text;
