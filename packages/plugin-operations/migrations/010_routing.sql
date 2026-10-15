-- Wave 15 (R1) routing: agent pools, routing points (drafts), immutable routing releases and
-- per-call member claims. Additive: existing inbound routes keep release_id and satisfy the new
-- one-target CHECK; with OVO_ROUTING_ENABLED=false nothing reads these tables at admission.
CREATE TABLE IF NOT EXISTS ovo_routing_pools (
  organization_id text NOT NULL,
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (organization_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ovo_routing_pools_name_idx
  ON ovo_routing_pools (organization_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ovo_routing_points (
  organization_id text NOT NULL,
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  draft jsonb NOT NULL CHECK (jsonb_typeof(draft) = 'object'),
  draft_version bigint NOT NULL DEFAULT 1 CHECK (draft_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (organization_id, id)
);

-- Which pools a point's current draft names: maintained on point create/update; guards pool delete.
CREATE TABLE IF NOT EXISTS ovo_routing_point_pools (
  organization_id text NOT NULL,
  point_id uuid NOT NULL,
  pool_id uuid NOT NULL,
  PRIMARY KEY (organization_id, point_id, pool_id),
  FOREIGN KEY (organization_id, point_id) REFERENCES ovo_routing_points (organization_id, id)
);

CREATE TABLE IF NOT EXISTS ovo_routing_releases (
  organization_id text NOT NULL,
  id uuid NOT NULL,
  routing_point_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  draft_version bigint NOT NULL CHECK (draft_version > 0),
  router_release_id uuid NOT NULL,
  default_release_id uuid NOT NULL,
  release_ids uuid[] NOT NULL CHECK (cardinality(release_ids) BETWEEN 2 AND 500),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, routing_point_id, version),
  FOREIGN KEY (organization_id, routing_point_id) REFERENCES ovo_routing_points (organization_id, id)
);
CREATE OR REPLACE FUNCTION ovo_routing_releases_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'routing releases are immutable'; END $$;
DROP TRIGGER IF EXISTS ovo_routing_releases_immutable ON ovo_routing_releases;
CREATE TRIGGER ovo_routing_releases_immutable BEFORE UPDATE OR DELETE ON ovo_routing_releases
  FOR EACH ROW EXECUTE FUNCTION ovo_routing_releases_immutable();

CREATE TABLE IF NOT EXISTS ovo_routing_member_claims (
  organization_id text NOT NULL,
  id uuid NOT NULL,
  call_id text NOT NULL CHECK (length(call_id) BETWEEN 1 AND 200),   -- the job id
  routing_release_id uuid NOT NULL,
  pool_id uuid NOT NULL,
  member_id text NOT NULL,
  release_id uuid NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  PRIMARY KEY (organization_id, id)
);
CREATE INDEX IF NOT EXISTS ovo_routing_member_claims_active_idx
  ON ovo_routing_member_claims (organization_id, pool_id, member_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ovo_routing_member_claims_call_idx
  ON ovo_routing_member_claims (organization_id, call_id) WHERE released_at IS NULL;

ALTER TABLE ovo_ops_inbound_routes
  ADD COLUMN IF NOT EXISTS routing_release_id uuid,
  ALTER COLUMN release_id DROP NOT NULL;
ALTER TABLE ovo_ops_inbound_routes DROP CONSTRAINT IF EXISTS ovo_ops_inbound_routes_target_chk;
ALTER TABLE ovo_ops_inbound_routes ADD CONSTRAINT ovo_ops_inbound_routes_target_chk
  CHECK ((release_id IS NULL) <> (routing_release_id IS NULL));
ALTER TABLE ovo_ops_inbound_routes DROP CONSTRAINT IF EXISTS ovo_ops_inbound_routes_routing_fk;
ALTER TABLE ovo_ops_inbound_routes ADD CONSTRAINT ovo_ops_inbound_routes_routing_fk
  FOREIGN KEY (organization_id, routing_release_id) REFERENCES ovo_routing_releases (organization_id, id);

ALTER TABLE ovo_ops_inbound_admissions
  ADD COLUMN IF NOT EXISTS routing_release_id uuid;
