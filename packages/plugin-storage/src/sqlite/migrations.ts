import type { DatabaseSync } from 'node:sqlite';

export function migrate(db: DatabaseSync) {
  const foreignKeys = Number(
    (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys,
  );
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
CREATE TABLE IF NOT EXISTS ovo_control_schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),config_json TEXT NOT NULL,draft_version INTEGER NOT NULL CHECK(draft_version>0),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(workspace_id,id));
CREATE TABLE IF NOT EXISTS releases(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),agent_id TEXT NOT NULL REFERENCES agents(id),draft_version INTEGER NOT NULL,config_json TEXT NOT NULL,plugins_json TEXT NOT NULL,created_at TEXT NOT NULL,created_by TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS releases_agent_idx ON releases(workspace_id,agent_id,created_at);
CREATE TABLE IF NOT EXISTS credentials(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),label TEXT NOT NULL,provider TEXT NOT NULL,type TEXT NOT NULL,environment TEXT NOT NULL,backend TEXT NOT NULL CHECK(backend IN ('local','aws-secrets-manager')),current_version INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','retired')),permitted_agent_ids_json TEXT NOT NULL,expires_at TEXT,created_by TEXT NOT NULL,created_at TEXT NOT NULL,rotated_at TEXT,retired_at TEXT,fingerprint TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS secret_versions(credential_id TEXT NOT NULL REFERENCES credentials(id),version INTEGER NOT NULL,ciphertext BLOB,nonce BLOB,auth_tag BLOB,backend_ref TEXT,created_at TEXT NOT NULL,PRIMARY KEY(credential_id,version),CHECK((ciphertext IS NOT NULL AND nonce IS NOT NULL AND auth_tag IS NOT NULL AND backend_ref IS NULL) OR (ciphertext IS NULL AND nonce IS NULL AND auth_tag IS NULL AND backend_ref IS NOT NULL)));
CREATE TABLE IF NOT EXISTS provider_bindings(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),label TEXT NOT NULL,provider TEXT NOT NULL,environment TEXT NOT NULL,credential_id TEXT NOT NULL REFERENCES credentials(id),config_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mcp_connections(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),label TEXT NOT NULL,endpoint TEXT NOT NULL,auth TEXT NOT NULL CHECK(auth IN ('none','bearer')),credential_id TEXT REFERENCES credentials(id),status TEXT NOT NULL CHECK(status IN ('unverified','ready','error')),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_mcp_tools(workspace_id TEXT NOT NULL REFERENCES workspaces(id),agent_id TEXT NOT NULL REFERENCES agents(id),tool_id TEXT NOT NULL,connection_id TEXT NOT NULL REFERENCES mcp_connections(id),remote_name TEXT NOT NULL,schema_digest TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(workspace_id,agent_id,tool_id));
CREATE TABLE IF NOT EXISTS mcp_discovered_tools(connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,remote_name TEXT NOT NULL,description TEXT NOT NULL,input_schema_json TEXT NOT NULL,output_schema_json TEXT,schema_digest TEXT NOT NULL,discovered_at TEXT NOT NULL,PRIMARY KEY(connection_id,remote_name));
CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),release_id TEXT NOT NULL REFERENCES releases(id),kind TEXT NOT NULL CHECK(kind IN ('live','simulation')),status TEXT NOT NULL,created_at TEXT NOT NULL,completed_at TEXT);
CREATE TABLE IF NOT EXISTS call_events(id TEXT PRIMARY KEY,call_id TEXT NOT NULL REFERENCES calls(id),sequence INTEGER NOT NULL,at TEXT NOT NULL,type TEXT NOT NULL,epoch INTEGER NOT NULL,payload_json TEXT NOT NULL,UNIQUE(call_id,sequence));
CREATE TABLE IF NOT EXISTS evaluations(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),release_id TEXT NOT NULL REFERENCES releases(id),status TEXT NOT NULL CHECK(status IN ('passed','failed')),fixtures_json TEXT NOT NULL,created_at TEXT NOT NULL,created_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS operations(workspace_id TEXT NOT NULL REFERENCES workspaces(id),id TEXT NOT NULL,record_json TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(workspace_id,id));
CREATE TABLE IF NOT EXISTS usage_entries(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),call_id TEXT NOT NULL REFERENCES calls(id),provider TEXT NOT NULL,request_id TEXT NOT NULL,quantity TEXT NOT NULL,unit TEXT NOT NULL,price_card_id TEXT NOT NULL,price_card_version TEXT NOT NULL,amount_minor TEXT NOT NULL,currency TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('estimated','reconciled')),created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_entries(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),actor_id TEXT NOT NULL,action TEXT NOT NULL,resource_type TEXT NOT NULL,resource_id TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL);
`);
    db.prepare(
      'INSERT OR IGNORE INTO ovo_control_schema_migrations(version,applied_at) VALUES(1,?)',
    ).run(new Date().toISOString());
    const releaseColumns = db.prepare('PRAGMA table_info(releases)').all() as { name: string }[];
    if (!releaseColumns.some((column) => column.name === 'provider_bindings_json'))
      db.exec("ALTER TABLE releases ADD COLUMN provider_bindings_json TEXT NOT NULL DEFAULT '{}'");
    db.prepare(
      'INSERT OR IGNORE INTO ovo_control_schema_migrations(version,applied_at) VALUES(2,?)',
    ).run(new Date().toISOString());
    if (!releaseColumns.some((column) => column.name === 'mcp_tools_json'))
      db.exec("ALTER TABLE releases ADD COLUMN mcp_tools_json TEXT NOT NULL DEFAULT '{}'");
    db.prepare(
      'INSERT OR IGNORE INTO ovo_control_schema_migrations(version,applied_at) VALUES(3,?)',
    ).run(new Date().toISOString());
    const version4 = db
      .prepare('SELECT 1 FROM ovo_control_schema_migrations WHERE version=4')
      .get();
    if (!version4) {
      const releaseColumns4 = db.prepare('PRAGMA table_info(releases)').all() as { name: string }[];
      if (!releaseColumns4.some((column) => column.name === 'selections_json'))
        db.exec(
          "ALTER TABLE releases ADD COLUMN selections_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(selections_json) AND json_type(selections_json)='object')",
        );
      const bindingColumns = db.prepare('PRAGMA table_info(provider_bindings)').all() as {
        name: string;
      }[];
      if (!bindingColumns.some((column) => column.name === 'kind'))
        db.exec('ALTER TABLE provider_bindings ADD COLUMN kind TEXT');
      if (!bindingColumns.some((column) => column.name === 'plugin_id'))
        db.exec('ALTER TABLE provider_bindings ADD COLUMN plugin_id TEXT');
      db.exec(`
        UPDATE provider_bindings SET kind='stt',plugin_id='@winsendotai/ovo-provider-deepgram-stt' WHERE kind IS NULL AND plugin_id IS NULL AND provider='deepgram';
        UPDATE provider_bindings SET kind='carrier',plugin_id='@winsendotai/ovo-carrier-twilio' WHERE kind IS NULL AND plugin_id IS NULL AND provider='twilio';
        UPDATE provider_bindings SET kind='tts',plugin_id='@winsendotai/ovo-provider-openai-tts'
         WHERE kind IS NULL AND plugin_id IS NULL AND provider='openai'
           AND EXISTS (SELECT 1 FROM agents a WHERE a.workspace_id=provider_bindings.workspace_id AND json_extract(a.config_json,'$.providers.tts')=provider_bindings.id)
           AND NOT EXISTS (SELECT 1 FROM agents a,json_each(a.config_json,'$.providers') p WHERE a.workspace_id=provider_bindings.workspace_id AND p.value=provider_bindings.id AND p.key<>'tts');
        UPDATE provider_bindings SET kind='llm',plugin_id='@winsendotai/ovo-provider-openai-inference'
         WHERE kind IS NULL AND plugin_id IS NULL AND provider='openai'
           AND EXISTS (SELECT 1 FROM agents a WHERE a.workspace_id=provider_bindings.workspace_id AND json_extract(a.config_json,'$.providers.inference')=provider_bindings.id)
           AND NOT EXISTS (SELECT 1 FROM agents a,json_each(a.config_json,'$.providers') p WHERE a.workspace_id=provider_bindings.workspace_id AND p.value=provider_bindings.id AND p.key<>'inference');
      `);
      db.exec(`
        CREATE TABLE calls_v4(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),release_id TEXT NOT NULL REFERENCES releases(id),kind TEXT NOT NULL CHECK(kind IN ('live','simulation','test')),status TEXT NOT NULL,created_at TEXT NOT NULL,completed_at TEXT);
        INSERT INTO calls_v4 SELECT * FROM calls;
        DROP TABLE calls;
        ALTER TABLE calls_v4 RENAME TO calls;
      `);
      db.prepare('INSERT INTO ovo_control_schema_migrations(version,applied_at) VALUES(4,?)').run(
        new Date().toISOString(),
      );
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('Control migration left broken foreign keys');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    if (foreignKeys) db.exec('PRAGMA foreign_keys=ON');
  }
}
