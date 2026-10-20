-- Wave 18 (R4) routing eval runs: a corpus of scripted callers scored against one routing release,
-- kept with its scorecard so the console can chart accuracy over time. The cases are authored,
-- synthetic utterances (not call recordings); a run is soft-deleted. Additive: nothing reads this
-- table unless routing is enabled and a run is created. Not reversed by a code rollback; take a
-- backup before deploying.
CREATE TABLE IF NOT EXISTS ovo_routing_eval_runs (
  organization_id text NOT NULL,
  id uuid NOT NULL,
  routing_release_id uuid NOT NULL,
  routing_point_id uuid NOT NULL,
  release_version integer NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  engine_mode text NOT NULL CHECK (engine_mode IN ('recorded')),
  corpus_digest text NOT NULL CHECK (corpus_digest ~ '^[0-9a-f]{64}$'),
  case_count integer NOT NULL CHECK (case_count BETWEEN 1 AND 500),
  scorecard jsonb NOT NULL CHECK (jsonb_typeof(scorecard) = 'object'),
  corpus jsonb NOT NULL CHECK (jsonb_typeof(corpus) = 'array'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, routing_release_id) REFERENCES ovo_routing_releases (organization_id, id)
);
CREATE INDEX IF NOT EXISTS ovo_routing_eval_runs_recent_idx
  ON ovo_routing_eval_runs (organization_id, created_at DESC) WHERE deleted_at IS NULL;
