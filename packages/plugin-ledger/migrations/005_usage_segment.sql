-- Wave 16 (R2): which segment of a routed call metered a usage row. A call can change agents
-- mid-call on one carrier leg and one cost reservation; each agent segment's usage is tagged so a
-- call's cost can be read per segment. NULL is call-level usage (carrier time, hold-voice
-- generation) and every row recorded before this migration.
ALTER TABLE ovo_cost_native_usage ADD COLUMN IF NOT EXISTS segment_index smallint
  CHECK (segment_index IS NULL OR segment_index BETWEEN 0 AND 63);
