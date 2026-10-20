-- Wave 17 (R3) human queues: queue definitions, operator profiles and presence, tickets and their
-- audit events. Additive: with OVO_HUMAN_QUEUE_ENABLED=false nothing reads or writes these tables.
-- Not reversed by a code rollback; take a backup before deploying.
CREATE TABLE IF NOT EXISTS ovo_hq_queues (
  organization_id text NOT NULL,
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (kind IN ('external', 'managed')),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  team_ids text[] NOT NULL DEFAULT '{}',           -- denormalised from a managed definition
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (organization_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ovo_hq_queues_name_idx
  ON ovo_hq_queues (organization_id, lower(name)) WHERE deleted_at IS NULL;

-- Which queues a point's current draft binds: maintained on point create/update (like
-- ovo_routing_point_pools); guards queue delete.
CREATE TABLE IF NOT EXISTS ovo_hq_point_queues (
  organization_id text NOT NULL,
  point_id uuid NOT NULL,
  queue_id uuid NOT NULL,
  PRIMARY KEY (organization_id, point_id, queue_id),
  FOREIGN KEY (organization_id, point_id) REFERENCES ovo_routing_points (organization_id, id)
);

CREATE TABLE IF NOT EXISTS ovo_hq_operators (
  organization_id text NOT NULL,
  user_id text NOT NULL CHECK (length(user_id) BETWEEN 1 AND 200),
  display_name text NOT NULL DEFAULT '' CHECK (length(display_name) <= 120),
  enabled boolean NOT NULL DEFAULT true,
  team_ids text[] NOT NULL DEFAULT '{}',
  languages text[] NOT NULL DEFAULT '{}',
  capacity integer NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 0 AND 20),
  status text NOT NULL DEFAULT 'OFFLINE' CHECK (status IN ('AVAILABLE', 'AWAY', 'OFFLINE')),
  status_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,                         -- desk heartbeat; older than the TTL reads as OFFLINE
  last_assigned_at timestamptz,                     -- AUTO_ASSIGN fairness (longest idle first)
  PRIMARY KEY (organization_id, user_id)
);

CREATE SEQUENCE IF NOT EXISTS ovo_hq_change_seq;

CREATE TABLE IF NOT EXISTS ovo_hq_tickets (
  organization_id text NOT NULL,
  id uuid NOT NULL,
  call_id text NOT NULL CHECK (length(call_id) BETWEEN 1 AND 200),        -- the job id
  session_id text,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  routing_release_id uuid,
  queue_id uuid NOT NULL,
  queue_key text NOT NULL,
  queue_name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('external', 'managed')),
  mode text NOT NULL CHECK (mode IN ('AUTO_ASSIGN', 'OPEN_PICKUP')),
  team_ids text[] NOT NULL DEFAULT '{}',            -- who may take it, pinned from the release's queue
  language_mode text NOT NULL DEFAULT 'prefer' CHECK (language_mode IN ('ignore', 'prefer', 'require')),
  offer_seconds integer NOT NULL DEFAULT 20 CHECK (offer_seconds BETWEEN 1 AND 3600),
  status text NOT NULL CHECK (status IN ('waiting', 'offered', 'accepted', 'released', 'expired')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  priority smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 9),
  language text,
  caller_masked text,
  assigned_operator_id text,
  declined_by text[] NOT NULL DEFAULT '{}',
  offer_expires_at timestamptz,
  expires_at timestamptz NOT NULL,                  -- the hold's deadline; the sweeper expires past it
  room_name text,                                   -- managed: set at accept
  accepted_at timestamptz,
  connected_at timestamptz,
  released_at timestamptz,
  release_code text,
  outcome text,
  worker_heartbeat_at timestamptz,                  -- the worker holding the call, every 5 s
  command jsonb,                                    -- the operator's pending DeskCommand
  command_seq integer NOT NULL DEFAULT 0,
  command_ack integer NOT NULL DEFAULT 0,
  wrap_up jsonb,
  router_agent_id text,                             -- whose credential policy resolves the webhook secret
  credential_id text,
  callback_until timestamptz,                       -- external: callbacks accepted until
  external_ref text,
  destination jsonb,                                -- external: the answered destination (policy-checked)
  context jsonb,                                    -- SENSITIVE: TicketContext; nulled after retention
  context_retention_hours integer NOT NULL DEFAULT 24 CHECK (context_retention_hours BETWEEN 0 AND 720),
  context_expires_at timestamptz,                   -- scrub time, set when the ticket ends
  context_token_hash text,                          -- sha256 of the bearer a third party fetches context with
  context_token_expires_at timestamptz,
  change_id bigint NOT NULL DEFAULT nextval('ovo_hq_change_seq'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, idempotency_key)
);
-- One ticket in flight per call (an overflow chain releases the first before opening the second).
CREATE UNIQUE INDEX IF NOT EXISTS ovo_hq_tickets_active_call_idx
  ON ovo_hq_tickets (organization_id, call_id) WHERE status IN ('waiting', 'offered', 'accepted');
CREATE INDEX IF NOT EXISTS ovo_hq_tickets_queue_idx
  ON ovo_hq_tickets (organization_id, queue_id, priority DESC, created_at)
  WHERE status IN ('waiting', 'offered');
CREATE INDEX IF NOT EXISTS ovo_hq_tickets_operator_idx
  ON ovo_hq_tickets (organization_id, assigned_operator_id) WHERE status IN ('offered', 'accepted');
CREATE INDEX IF NOT EXISTS ovo_hq_tickets_change_idx ON ovo_hq_tickets (organization_id, change_id);
CREATE INDEX IF NOT EXISTS ovo_hq_tickets_scrub_idx
  ON ovo_hq_tickets (context_expires_at) WHERE context IS NOT NULL;

-- Append-only audit of a ticket: state changes, webhook attempts, callbacks (ids and codes only).
CREATE TABLE IF NOT EXISTS ovo_hq_ticket_events (
  organization_id text NOT NULL,
  ticket_id uuid NOT NULL,
  id uuid NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,          -- insertion order, for a ticket's history
  kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 60),
  source_event_id text CHECK (source_event_id IS NULL OR length(source_event_id) BETWEEN 1 AND 200),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) < 4096),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, ticket_id, id),
  FOREIGN KEY (organization_id, ticket_id) REFERENCES ovo_hq_tickets (organization_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ovo_hq_ticket_events_dedup_idx
  ON ovo_hq_ticket_events (organization_id, ticket_id, source_event_id)
  WHERE source_event_id IS NOT NULL;
