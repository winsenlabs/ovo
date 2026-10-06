-- Durable speech clips (TTS-8). Audio for fixed release lines only: per-call (variable) lines and
-- model output are never written here. A clip is keyed by the full speech cache identity digest,
-- which already contains the workspace, voice, model, format, binding revision and text.
CREATE TABLE IF NOT EXISTS ovo_speech_clips (
  workspace_id text NOT NULL,
  clip_key text NOT NULL CHECK (clip_key ~ '^[0-9a-f]{64}$'),
  codec text NOT NULL,
  sample_rate integer NOT NULL CHECK (sample_rate > 0),
  byte_length integer NOT NULL CHECK (byte_length > 0 AND byte_length <= 8388608),
  audio bytea NOT NULL CHECK (octet_length(audio) = byte_length),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, clip_key)
);
CREATE INDEX IF NOT EXISTS ovo_speech_clips_gc_idx ON ovo_speech_clips (last_used_at);

-- Which release needs which clip, and whether its render succeeded. Refs keep clips alive for GC.
CREATE TABLE IF NOT EXISTS ovo_speech_clip_refs (
  workspace_id text NOT NULL,
  release_id text NOT NULL,
  clip_key text NOT NULL CHECK (clip_key ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('ready', 'failed')),
  error text CHECK (error IS NULL OR length(error) <= 500),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, release_id, clip_key)
);
CREATE INDEX IF NOT EXISTS ovo_speech_clip_refs_key_idx
  ON ovo_speech_clip_refs (workspace_id, clip_key);
CREATE INDEX IF NOT EXISTS ovo_speech_clip_refs_gc_idx ON ovo_speech_clip_refs (updated_at);

-- One pre-render request per release; a newer request for the same release replaces the old one.
CREATE TABLE IF NOT EXISTS ovo_speech_prerender_jobs (
  workspace_id text NOT NULL,
  release_id text NOT NULL,
  agent_id text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('publish', 'worker-start', 'first-call')),
  state text NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed', 'skipped')),
  total integer NOT NULL DEFAULT 0 CHECK (total >= 0),
  per_call integer NOT NULL DEFAULT 0 CHECK (per_call >= 0),
  inventory_sha256 text,
  detail text CHECK (detail IS NULL OR length(detail) <= 500),
  attempts integer NOT NULL DEFAULT 0,
  worker_id text,
  lease_until timestamptz,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (workspace_id, release_id)
);
CREATE INDEX IF NOT EXISTS ovo_speech_prerender_jobs_queue_idx
  ON ovo_speech_prerender_jobs (state, requested_at);
