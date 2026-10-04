export const controlSchemaV1 = `
CREATE TABLE ovo_ctl_workspaces (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  name TEXT NOT NULL CHECK (length(name) > 0),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE ovo_ctl_agents (
  workspace_id TEXT NOT NULL REFERENCES ovo_ctl_workspaces(id),
  id TEXT NOT NULL CHECK (length(id) > 0),
  config JSONB NOT NULL,
  draft_version INTEGER NOT NULL CHECK (draft_version > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE ovo_ctl_releases (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) > 0),
  agent_id TEXT NOT NULL,
  draft_version INTEGER NOT NULL CHECK (draft_version > 0),
  config JSONB NOT NULL,
  plugins JSONB NOT NULL CHECK (jsonb_typeof(plugins) = 'array'),
  created_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL CHECK (length(created_by) > 0),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, agent_id, draft_version),
  FOREIGN KEY (workspace_id, agent_id)
    REFERENCES ovo_ctl_agents(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX ovo_ctl_releases_agent_page_idx
  ON ovo_ctl_releases(workspace_id, agent_id, created_at, id);

CREATE TABLE ovo_ctl_credentials (
  workspace_id TEXT NOT NULL REFERENCES ovo_ctl_workspaces(id),
  id TEXT NOT NULL CHECK (length(id) > 0),
  label TEXT NOT NULL CHECK (length(label) > 0),
  provider TEXT NOT NULL CHECK (length(provider) > 0),
  type TEXT NOT NULL CHECK (length(type) > 0),
  environment TEXT NOT NULL CHECK (length(environment) > 0),
  backend TEXT NOT NULL CHECK (backend IN ('local','encrypted-store','aws-secrets-manager')),
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  status TEXT NOT NULL CHECK (status IN ('active','retired')),
  permitted_agent_ids JSONB NOT NULL CHECK (jsonb_typeof(permitted_agent_ids) = 'array'),
  expires_at TIMESTAMPTZ,
  created_by TEXT NOT NULL CHECK (length(created_by) > 0),
  created_at TIMESTAMPTZ NOT NULL,
  rotated_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) > 0),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE ovo_ctl_secret_versions (
  workspace_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  backend TEXT NOT NULL CHECK (backend IN ('local','encrypted-store','aws-secrets-manager')),
  ciphertext BYTEA,
  nonce BYTEA,
  auth_tag BYTEA,
  backend_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, credential_id, version),
  FOREIGN KEY (workspace_id, credential_id)
    REFERENCES ovo_ctl_credentials(workspace_id, id) ON DELETE RESTRICT,
  CHECK (
    (backend IN ('local','encrypted-store') AND ciphertext IS NOT NULL AND nonce IS NOT NULL AND auth_tag IS NOT NULL AND backend_ref IS NULL)
    OR
    (backend = 'aws-secrets-manager' AND ciphertext IS NULL AND nonce IS NULL AND auth_tag IS NULL AND backend_ref IS NOT NULL)
  )
);

CREATE TABLE ovo_ctl_provider_bindings (
  workspace_id TEXT NOT NULL REFERENCES ovo_ctl_workspaces(id),
  id TEXT NOT NULL CHECK (length(id) > 0),
  label TEXT NOT NULL CHECK (length(label) > 0),
  provider TEXT NOT NULL CHECK (length(provider) > 0),
  environment TEXT NOT NULL CHECK (length(environment) > 0),
  credential_id TEXT NOT NULL,
  config JSONB NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, credential_id)
    REFERENCES ovo_ctl_credentials(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX ovo_ctl_provider_bindings_page_idx
  ON ovo_ctl_provider_bindings(workspace_id, created_at, id);

CREATE TABLE ovo_ctl_mcp_connections (
  workspace_id TEXT NOT NULL REFERENCES ovo_ctl_workspaces(id),
  id TEXT NOT NULL CHECK (length(id) > 0),
  label TEXT NOT NULL CHECK (length(label) > 0),
  endpoint TEXT NOT NULL CHECK (length(endpoint) > 0),
  auth TEXT NOT NULL CHECK (auth IN ('none','bearer')),
  credential_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('unverified','ready','error')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, credential_id)
    REFERENCES ovo_ctl_credentials(workspace_id, id) ON DELETE RESTRICT,
  CHECK ((auth = 'none' AND credential_id IS NULL) OR (auth = 'bearer' AND credential_id IS NOT NULL))
);

CREATE TABLE ovo_ctl_mcp_discovered_tools (
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  remote_name TEXT NOT NULL CHECK (length(remote_name) > 0),
  description TEXT NOT NULL,
  input_schema JSONB NOT NULL CHECK (jsonb_typeof(input_schema) = 'object'),
  output_schema JSONB CHECK (output_schema IS NULL OR jsonb_typeof(output_schema) = 'object'),
  schema_digest TEXT NOT NULL CHECK (length(schema_digest) > 0),
  discovered_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, connection_id, remote_name),
  FOREIGN KEY (workspace_id, connection_id)
    REFERENCES ovo_ctl_mcp_connections(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE ovo_ctl_agent_mcp_tools (
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  tool_id TEXT NOT NULL CHECK (length(tool_id) > 0),
  connection_id TEXT NOT NULL,
  remote_name TEXT NOT NULL,
  schema_digest TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, agent_id, tool_id),
  FOREIGN KEY (workspace_id, agent_id)
    REFERENCES ovo_ctl_agents(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, connection_id, remote_name)
    REFERENCES ovo_ctl_mcp_discovered_tools(workspace_id, connection_id, remote_name) ON DELETE RESTRICT
);

CREATE TABLE ovo_ctl_calls (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) > 0),
  release_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('live','simulation')),
  status TEXT NOT NULL CHECK (length(status) > 0),
  created_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, release_id)
    REFERENCES ovo_ctl_releases(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX ovo_ctl_calls_page_idx ON ovo_ctl_calls(workspace_id, created_at, id);

CREATE TABLE ovo_ctl_call_events (
  workspace_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) > 0),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  at TIMESTAMPTZ NOT NULL,
  type TEXT NOT NULL CHECK (length(type) > 0),
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  PRIMARY KEY (workspace_id, call_id, sequence),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, call_id)
    REFERENCES ovo_ctl_calls(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE ovo_ctl_evaluations (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) > 0),
  release_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('passed','failed')),
  fixtures JSONB NOT NULL CHECK (jsonb_typeof(fixtures) = 'array'),
  created_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL CHECK (length(created_by) > 0),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, release_id)
    REFERENCES ovo_ctl_releases(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE ovo_ctl_operations (
  workspace_id TEXT NOT NULL REFERENCES ovo_ctl_workspaces(id),
  id TEXT NOT NULL CHECK (length(id) > 0),
  record JSONB NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE ovo_ctl_usage_entries (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) > 0),
  call_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (length(provider) > 0),
  request_id TEXT NOT NULL CHECK (length(request_id) > 0),
  quantity TEXT NOT NULL CHECK (quantity ~ '^\\d+(\\.\\d+)?$'),
  unit TEXT NOT NULL CHECK (length(unit) > 0),
  price_card_id TEXT NOT NULL CHECK (length(price_card_id) > 0),
  price_card_version TEXT NOT NULL CHECK (length(price_card_version) > 0),
  amount_minor TEXT NOT NULL CHECK (amount_minor ~ '^\\d+$'),
  currency TEXT NOT NULL CHECK (length(currency) > 0),
  state TEXT NOT NULL CHECK (state IN ('estimated','reconciled')),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, call_id, provider, request_id, unit, price_card_id, price_card_version, state),
  FOREIGN KEY (workspace_id, call_id)
    REFERENCES ovo_ctl_calls(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE ovo_ctl_audit_entries (
  workspace_id TEXT NOT NULL REFERENCES ovo_ctl_workspaces(id),
  id TEXT NOT NULL CHECK (length(id) > 0),
  actor_id TEXT NOT NULL CHECK (length(actor_id) > 0),
  action TEXT NOT NULL CHECK (length(action) > 0),
  resource_type TEXT NOT NULL CHECK (length(resource_type) > 0),
  resource_id TEXT NOT NULL CHECK (length(resource_id) > 0),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX ovo_ctl_audit_page_idx ON ovo_ctl_audit_entries(workspace_id, created_at, id);
`;
