-- Wave 16: the variable schema of a routed number's default agent, captured when the number is
-- bound. The overflow callback dials that agent, and the number's variables were checked against
-- the router release, so the callback passes only what this schema declares. NULL for a direct
-- number and for bindings made before it existed (their variables pass unfiltered until re-bound).
ALTER TABLE ovo_ops_inbound_routes
  ADD COLUMN IF NOT EXISTS default_variables_schema jsonb
    CHECK (default_variables_schema IS NULL OR jsonb_typeof(default_variables_schema) = 'object');
