-- Wave 16 (R2) in-call transfer: hold clips and which clips a point's draft names. Additive; with
-- OVO_ROUTING_TRANSFER_ENABLED=false nothing plays them.
--
-- A clip is an operator-uploaded WAV converted once to 8 kHz mu-law (0.1-300 s, so at most 2.4 MB).
CREATE TABLE IF NOT EXISTS ovo_routing_audio (
  organization_id text NOT NULL,
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  codec text NOT NULL CHECK (codec = 'audio/x-mulaw'),
  sample_rate integer NOT NULL CHECK (sample_rate = 8000),
  duration_ms integer NOT NULL CHECK (duration_ms BETWEEN 100 AND 300000),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 800 AND 2400000),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  audio bytea NOT NULL CHECK (octet_length(audio) = byte_length),
  source jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source) = 'object'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (organization_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ovo_routing_audio_name_idx
  ON ovo_routing_audio (organization_id, lower(name)) WHERE deleted_at IS NULL;

-- Bytes never change and rows are never deleted: only deleted_at may be set, because releases pin
-- a clip by its sha256 and keep playing a soft-deleted one.
CREATE OR REPLACE FUNCTION ovo_routing_audio_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.audio IS DISTINCT FROM OLD.audio OR NEW.sha256 <> OLD.sha256
     OR NEW.byte_length <> OLD.byte_length THEN
    RAISE EXCEPTION 'routing audio is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ovo_routing_audio_immutable ON ovo_routing_audio;
CREATE TRIGGER ovo_routing_audio_immutable BEFORE UPDATE OR DELETE ON ovo_routing_audio
  FOR EACH ROW EXECUTE FUNCTION ovo_routing_audio_immutable();

-- Which clips a point's current draft names: maintained with ovo_routing_point_pools on point
-- create/update; guards clip delete.
CREATE TABLE IF NOT EXISTS ovo_routing_point_audio (
  organization_id text NOT NULL,
  point_id uuid NOT NULL,
  audio_id uuid NOT NULL,
  PRIMARY KEY (organization_id, point_id, audio_id),
  FOREIGN KEY (organization_id, point_id) REFERENCES ovo_routing_points (organization_id, id)
);
