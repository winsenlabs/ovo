ALTER TABLE ovo_ops_inbound_routes
  ADD COLUMN IF NOT EXISTS carrier_plugin_id text,
  ADD COLUMN IF NOT EXISTS carrier_binding_id text;
