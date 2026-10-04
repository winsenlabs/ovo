ALTER TABLE ovo_jobs
  ADD COLUMN IF NOT EXISTS hinted_at timestamptz,
  ADD COLUMN IF NOT EXISTS hint_count integer NOT NULL DEFAULT 0;

DO $$
DECLARE status_constraint text;
BEGIN
  FOR status_constraint IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'ovo_jobs'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE ovo_jobs DROP CONSTRAINT %I', status_constraint);
  END LOOP;
END $$;

ALTER TABLE ovo_jobs ADD CONSTRAINT ovo_jobs_status_check CHECK (status IN (
  'queued', 'owned', 'dialing', 'reconcile_required', 'accepted',
  'connected', 'completed', 'failed', 'cancelled', 'superseded'
));

DROP TABLE IF EXISTS ovo_capacity_writes, ovo_capacity_leases;

-- Each dispatcher replica publishes independently. The API reads this durable latest signal.
CREATE TABLE IF NOT EXISTS ovo_capacity_signal_latest (
  service_key text PRIMARY KEY,
  signal jsonb NOT NULL CHECK (jsonb_typeof(signal) = 'object'),
  signal_at timestamptz NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now()
);
