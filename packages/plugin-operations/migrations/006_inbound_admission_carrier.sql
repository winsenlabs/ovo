-- Wait admissions retain the route's carrier choice across later route edits.
ALTER TABLE ovo_ops_inbound_admissions
  ADD COLUMN IF NOT EXISTS carrier_plugin_id text,
  ADD COLUMN IF NOT EXISTS carrier_binding_id text;
