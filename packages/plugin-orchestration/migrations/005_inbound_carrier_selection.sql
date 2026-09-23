-- Preserve the raw inbound route selection. NULL means the installed environment binding.
ALTER TABLE ovo_jobs
  ADD COLUMN IF NOT EXISTS carrier_plugin_id text,
  ADD COLUMN IF NOT EXISTS carrier_binding_id text;

ALTER TABLE ovo_session_routes
  ADD COLUMN IF NOT EXISTS carrier_plugin_id text,
  ADD COLUMN IF NOT EXISTS carrier_binding_id text;
