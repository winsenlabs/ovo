CREATE TABLE IF NOT EXISTS ovo_cost_schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ovo_cost_price_cards (
  id text NOT NULL,
  version text NOT NULL,
  fingerprint text NOT NULL,
  provider text NOT NULL,
  unit text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  minor_units_per_block text NOT NULL,
  block_quantity text NOT NULL,
  effective_at timestamptz NOT NULL,
  provenance text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS ovo_cost_fx_versions (
  id text NOT NULL,
  version text NOT NULL,
  fingerprint text NOT NULL,
  base_currency text NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
  quote_currency text NOT NULL CHECK (quote_currency = 'INR'),
  rate_numerator numeric(60,0) NOT NULL CHECK (rate_numerator >= 0),
  rate_denominator numeric(60,0) NOT NULL CHECK (rate_denominator > 0),
  effective_at timestamptz NOT NULL,
  provenance text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS ovo_cost_native_usage (
  id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  fingerprint text NOT NULL,
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  call_id text,
  attempt_id text,
  provider text NOT NULL,
  provider_request_id text,
  source_kind text NOT NULL CHECK (source_kind IN
    ('carrier','media','stt','tts-generation','llm','worker','network','recording','shared')),
  source_event_type text NOT NULL,
  source_event_id text NOT NULL,
  activity text NOT NULL CHECK (activity IN
    ('normal','failed-attempt','transfer','retry','startup','idle')),
  cache_disposition text NOT NULL CHECK (cache_disposition IN ('none','generation','hit')),
  quantity text NOT NULL,
  unit text NOT NULL,
  occurred_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('estimated', 'reconciled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_event_type, source_event_id, source_kind, unit)
);

CREATE TABLE IF NOT EXISTS ovo_cost_charges (
  id text PRIMARY KEY,
  usage_id text NOT NULL UNIQUE REFERENCES ovo_cost_native_usage(id),
  price_card_id text NOT NULL,
  price_card_version text NOT NULL,
  fx_id text,
  fx_version text,
  native_amount_minor numeric(60,0) NOT NULL CHECK (native_amount_minor >= 0),
  native_currency text NOT NULL,
  amount_paise numeric(60,0) NOT NULL CHECK (amount_paise >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (price_card_id, price_card_version)
    REFERENCES ovo_cost_price_cards(id, version),
  FOREIGN KEY (fx_id, fx_version)
    REFERENCES ovo_cost_fx_versions(id, version),
  CHECK ((fx_id IS NULL) = (fx_version IS NULL))
);

CREATE TABLE IF NOT EXISTS ovo_cost_corrections (
  id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  fingerprint text NOT NULL,
  usage_id text NOT NULL REFERENCES ovo_cost_native_usage(id),
  provider_invoice_id text NOT NULL,
  provider_invoice_line_id text NOT NULL,
  actual_amount_minor numeric(60,0) NOT NULL CHECK (actual_amount_minor >= 0),
  actual_currency text NOT NULL CHECK (actual_currency ~ '^[A-Z]{3}$'),
  fx_id text,
  fx_version text,
  delta_paise numeric(60,0) NOT NULL,
  effective_amount_paise numeric(60,0) NOT NULL CHECK (effective_amount_paise >= 0),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_invoice_id, provider_invoice_line_id),
  FOREIGN KEY (fx_id, fx_version)
    REFERENCES ovo_cost_fx_versions(id, version),
  CHECK ((fx_id IS NULL) = (fx_version IS NULL))
);

CREATE TABLE IF NOT EXISTS ovo_cost_allocation_batches (
  id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  fingerprint text NOT NULL,
  charge_id text NOT NULL REFERENCES ovo_cost_charges(id),
  amount_paise numeric(60,0) NOT NULL CHECK (amount_paise >= 0),
  basis text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ovo_cost_allocations (
  batch_id text NOT NULL REFERENCES ovo_cost_allocation_batches(id),
  target_id text NOT NULL,
  weight text NOT NULL,
  reason text NOT NULL CHECK (reason IN
    ('failed-attempt','transfer','retry','worker-shared','shared-service')),
  call_id text,
  attempt_id text,
  amount_paise numeric(60,0) NOT NULL CHECK (amount_paise >= 0),
  PRIMARY KEY (batch_id, target_id)
);

CREATE TABLE IF NOT EXISTS ovo_cost_budgets (
  id text PRIMARY KEY,
  fingerprint text NOT NULL,
  workspace_id text NOT NULL,
  limit_paise numeric(60,0) NOT NULL CHECK (limit_paise >= 0),
  admission_overspend_paise numeric(60,0) NOT NULL CHECK (admission_overspend_paise >= 0),
  spent_paise numeric(60,0) NOT NULL DEFAULT 0 CHECK (spent_paise >= 0),
  reserved_paise numeric(60,0) NOT NULL DEFAULT 0 CHECK (reserved_paise >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ovo_cost_reservations (
  id text PRIMARY KEY,
  fingerprint text NOT NULL,
  budget_id text NOT NULL REFERENCES ovo_cost_budgets(id),
  amount_paise numeric(60,0) NOT NULL CHECK (amount_paise >= 0),
  actual_paise numeric(60,0),
  source_ref text NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved', 'settled', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);

CREATE TABLE IF NOT EXISTS ovo_cost_budget_adjustments (
  id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  fingerprint text NOT NULL,
  budget_id text NOT NULL REFERENCES ovo_cost_budgets(id),
  delta_paise numeric(60,0) NOT NULL,
  source_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ovo_cost_usage_session_idx
  ON ovo_cost_native_usage(workspace_id, session_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS ovo_cost_usage_call_idx
  ON ovo_cost_native_usage(workspace_id, call_id, occurred_at, id)
  WHERE call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ovo_cost_corrections_usage_idx
  ON ovo_cost_corrections(usage_id, created_at, id);

INSERT INTO ovo_cost_schema_migrations(version) VALUES (1)
ON CONFLICT (version) DO NOTHING;
