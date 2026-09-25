import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { runControlMigrations } from '../src/index.ts';
import { PostgresControlStore } from '../src/index.ts';
import { controlSchemaV1 } from '../src/postgres/migrations/001-control-schema.ts';
import { releaseProviderBindingsV2 } from '../src/postgres/migrations/002-release-provider-bindings.ts';
import { releaseMcpToolsV3 } from '../src/postgres/migrations/003-release-mcp-tools.ts';
import { releaseSelectionsV4 } from '../src/postgres/migrations/004-release-selections.ts';
import { callKindConstraintV5 } from '../src/postgres/migrations/005-call-kind-constraint.ts';
import { migrationChecksum } from '../src/postgres/shared.ts';

const url = process.env.OVO_TEST_POSTGRES_URL;
const integration = url ? describe : describe.skip;

integration('F3 Postgres storage upgrade', () => {
  const schema = `f3_storage_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url! });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: url!, options: `-c search_path=${schema}` });
    const old = [
      { version: 1, name: 'control-schema', sql: controlSchemaV1 },
      { version: 2, name: 'release-provider-bindings', sql: releaseProviderBindingsV2 },
      { version: 3, name: 'release-mcp-tools', sql: releaseMcpToolsV3 },
    ];
    await pool.query(
      'CREATE TABLE ovo_control_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())',
    );
    for (const migration of old) {
      await pool.query(migration.sql);
      await pool.query(
        'INSERT INTO ovo_control_schema_migrations(version,name,checksum) VALUES($1,$2,$3)',
        [migration.version, migration.name, migrationChecksum(migration.sql)],
      );
    }
    await pool.query(
      "ALTER TABLE ovo_ctl_calls ADD CONSTRAINT ovo_ctl_calls_legacy_kind_second CHECK (kind IN ('live','simulation'))",
    );
    await pool.query(
      "ALTER TABLE ovo_ctl_calls ADD CONSTRAINT ovo_ctl_calls_kind_custom_guard CHECK (kind <> 'forbidden')",
    );
    await pool.query(
      "INSERT INTO ovo_ctl_workspaces(id,name,created_at) VALUES('w','Workspace',now())",
    );
    await pool.query(`INSERT INTO ovo_ctl_credentials(workspace_id,id,label,provider,type,environment,backend,current_version,status,permitted_agent_ids,created_by,created_at,fingerprint)
      VALUES('w','cred','Cred','openai','api-key','test','local',1,'active','[]','tester',now(),'fingerprint')`);
    for (const [id, provider] of [
      ['mixed', 'openai'],
      ['stt', 'deepgram'],
      ['tts', 'openai'],
    ] as const) {
      await pool.query(
        `INSERT INTO ovo_ctl_provider_bindings(workspace_id,id,label,provider,environment,credential_id,config,created_at,updated_at)
        VALUES('w',$1,$1,$2,'test','cred','{}',now(),now())`,
        [id, provider],
      );
    }
    for (const [id, providers] of [
      ['a', { tts: 'mixed', stt: 'stt' }],
      ['b', { inference: 'mixed' }],
      ['c', { tts: 'tts' }],
    ] as const) {
      const config = AgentConfig.parse({ name: id, mode: 'announcement', message: id, providers });
      await pool.query(
        `INSERT INTO ovo_ctl_agents(workspace_id,id,config,draft_version,created_at,updated_at)
        VALUES('w',$1,$2,1,now(),now())`,
        [id, config],
      );
      if (id === 'a')
        await pool.query(
          `INSERT INTO ovo_ctl_releases(workspace_id,id,agent_id,draft_version,config,plugins,provider_bindings,mcp_tools,created_at,created_by)
        VALUES('w','r','a',1,$1,'[]','{}','{}',now(),'tester')`,
          [config],
        );
    }
    await pool.query(
      "INSERT INTO ovo_ctl_calls(workspace_id,id,release_id,kind,status,created_at) VALUES('w','call','r','live','done',now())",
    );
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
  it('keeps the committed fourth migration checksum', () => {
    expect(migrationChecksum(releaseSelectionsV4)).toBe(
      'a38b5d02a65661666f613e79063baaf02a88bd919a27c4bbd43d4d880cbe5d2a',
    );
  });
  it('fails safely when an old call-kind check also guards another field', async () => {
    const compoundSchema = `f3_storage_compound_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${compoundSchema}`);
    const compoundPool = new pg.Pool({
      connectionString: url!,
      options: `-c search_path=${compoundSchema}`,
    });
    try {
      await compoundPool.query(
        'CREATE TABLE ovo_control_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())',
      );
      for (const migration of [
        { version: 1, name: 'control-schema', sql: controlSchemaV1 },
        { version: 2, name: 'release-provider-bindings', sql: releaseProviderBindingsV2 },
        { version: 3, name: 'release-mcp-tools', sql: releaseMcpToolsV3 },
      ]) {
        await compoundPool.query(migration.sql);
        await compoundPool.query(
          'INSERT INTO ovo_control_schema_migrations(version,name,checksum) VALUES($1,$2,$3)',
          [migration.version, migration.name, migrationChecksum(migration.sql)],
        );
      }
      await compoundPool.query(
        "ALTER TABLE ovo_ctl_calls ADD CONSTRAINT ovo_ctl_calls_kind_and_status CHECK (kind IN ('live','simulation') AND status <> 'void')",
      );
      await expect(runControlMigrations(compoundPool)).rejects.toThrow(
        'compound call-kind constraint ovo_ctl_calls_kind_and_status',
      );
      expect(
        (
          await compoundPool.query(
            "SELECT conname FROM pg_constraint WHERE conrelid='ovo_ctl_calls'::regclass AND conname='ovo_ctl_calls_kind_and_status'",
          )
        ).rowCount,
      ).toBe(1);
      await compoundPool.query(
        'ALTER TABLE ovo_ctl_calls DROP CONSTRAINT ovo_ctl_calls_kind_and_status',
      );
      await compoundPool.query(releaseSelectionsV4);
      await compoundPool.query(
        'INSERT INTO ovo_control_schema_migrations(version,name,checksum) VALUES(4,$1,$2)',
        ['release-selections', migrationChecksum(releaseSelectionsV4)],
      );
      await compoundPool.query(
        "ALTER TABLE ovo_ctl_calls ADD CONSTRAINT ovo_ctl_calls_kind_and_status CHECK (kind IN ('live','simulation') AND status <> 'void')",
      );
      await expect(runControlMigrations(compoundPool)).rejects.toThrow(
        'compound call-kind constraint ovo_ctl_calls_kind_and_status',
      );
      expect(
        (
          await compoundPool.query(
            "SELECT conname FROM pg_constraint WHERE conrelid='ovo_ctl_calls'::regclass AND conname='ovo_ctl_calls_kind_and_status'",
          )
        ).rowCount,
      ).toBe(1);
      await compoundPool.query(
        'ALTER TABLE ovo_ctl_calls DROP CONSTRAINT ovo_ctl_calls_kind_and_status',
      );
      await runControlMigrations(compoundPool);
      expect(
        (
          await compoundPool.query(
            'SELECT version FROM ovo_control_schema_migrations ORDER BY version',
          )
        ).rows.map((row) => row.version),
      ).toEqual([1, 2, 3, 4, 5]);
      await compoundPool.query(
        'ALTER TABLE ovo_ctl_calls DROP CONSTRAINT ovo_ctl_calls_kind_allowed',
      );
      await compoundPool.query(
        "ALTER TABLE ovo_ctl_calls ADD CONSTRAINT ovo_ctl_calls_kind_allowed CHECK (status <> 'void')",
      );
      await expect(compoundPool.query(callKindConstraintV5)).rejects.toThrow(
        'unexpected call-kind constraint ovo_ctl_calls_kind_allowed',
      );
    } finally {
      await compoundPool.end();
      await admin.query(`DROP SCHEMA ${compoundSchema} CASCADE`);
    }
  });
  it('removes every legacy narrow call-kind constraint during upgrade', async () => {
    await runControlMigrations(pool);
    const constraints = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid='ovo_ctl_calls'::regclass AND contype='c'
         AND pg_get_constraintdef(oid) LIKE '%kind%'
       ORDER BY conname`,
    );
    expect(constraints.rows.map((row) => row.conname)).toEqual([
      'ovo_ctl_calls_kind_allowed',
      'ovo_ctl_calls_kind_custom_guard',
    ]);
  });
  it('upgrades populated old schema, keeps rows, widens kind, rejects bad JSON, and never guesses mixed OpenAI', async () => {
    await runControlMigrations(pool);
    const versions = await pool.query(
      'SELECT version FROM ovo_control_schema_migrations ORDER BY version',
    );
    expect(versions.rows.map((row) => row.version)).toEqual([1, 2, 3, 4, 5]);
    expect(
      (await pool.query("SELECT id,selections FROM ovo_ctl_releases WHERE id='r'")).rows[0],
    ).toMatchObject({ id: 'r', selections: {} });
    const bindings = await pool.query(
      'SELECT id,kind,plugin_id FROM ovo_ctl_provider_bindings ORDER BY id',
    );
    expect(bindings.rows).toEqual([
      { id: 'mixed', kind: null, plugin_id: null },
      { id: 'stt', kind: 'stt', plugin_id: '@winsendotai/ovo-provider-deepgram-stt' },
      { id: 'tts', kind: 'tts', plugin_id: '@winsendotai/ovo-provider-openai-tts' },
    ]);
    expect((await pool.query("SELECT id FROM ovo_ctl_calls WHERE id='call'")).rowCount).toBe(1);
    await pool.query(
      "INSERT INTO ovo_ctl_calls(workspace_id,id,release_id,kind,status,created_at) VALUES('w','test','r','test','done',now())",
    );
    await expect(
      pool.query(
        "INSERT INTO ovo_ctl_calls(workspace_id,id,release_id,kind,status,created_at) VALUES('w','bad','r','invalid','done',now())",
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query("UPDATE ovo_ctl_releases SET selections='[]' WHERE id='r'"),
    ).rejects.toMatchObject({ code: '23514' });
    await runControlMigrations(pool);
    await pool.query(callKindConstraintV5);
    expect(
      (await pool.query("SELECT kind,plugin_id FROM ovo_ctl_provider_bindings WHERE id='mixed'"))
        .rows[0],
    ).toEqual({ kind: null, plugin_id: null });
  });
  it('persists selections and filters paged calls through the real repository', async () => {
    const store = await PostgresControlStore.open({
      connectionString: url!,
      options: `-c search_path=${schema}`,
    });
    try {
      const agent = await store.createAgent(
        'w',
        AgentConfig.parse({ name: 'Paged', mode: 'announcement', message: 'hello' }),
        'paged',
      );
      const release = await store.createRelease({
        workspaceId: 'w',
        agent,
        plugins: [],
        createdBy: 'test',
        id: 'paged-release',
        selections: {
          engine: { pluginId: 'engine.fixture', version: '1.0.0', config: {} },
          carrier: { pluginId: 'carrier.fixture', version: '1.0.0', config: {} },
        },
      });
      expect((await store.getRelease('w', release.id))?.selections).toEqual(release.selections);
      await store.createCall({
        workspaceId: 'w',
        releaseId: release.id,
        kind: 'test',
        status: 'pending',
        id: 'page-a',
      });
      await store.createCall({
        workspaceId: 'w',
        releaseId: release.id,
        kind: 'simulation',
        status: 'done',
        id: 'page-b',
      });
      await pool.query(
        "UPDATE ovo_ctl_calls SET created_at='2025-01-01T00:00:00Z' WHERE id IN ('page-a','page-b')",
      );
      expect(
        (
          await store.listCalls('w', 10, undefined, {
            agentId: 'paged',
            kind: 'test',
            status: 'pending',
            engine: 'engine.fixture',
            carrier: 'carrier.fixture',
          })
        ).items.map((item) => item.id),
      ).toEqual(['page-a']);
      expect((await store.listCalls('w', 10, undefined, { engine: 'engine.wrong' })).items).toEqual(
        [],
      );
      const desc = await store.listCalls('w', 1, undefined, { agentId: 'paged' });
      expect(desc.items.map((item) => item.id)).toEqual(['page-b']);
      expect(
        (await store.listCalls('w', 1, desc.nextCursor!, { agentId: 'paged' })).items.map(
          (item) => item.id,
        ),
      ).toEqual(['page-a']);
      const asc = await store.listCalls('w', 1, undefined, { agentId: 'paged', order: 'asc' });
      expect(asc.items.map((item) => item.id)).toEqual(['page-a']);
      expect(
        (
          await store.listCalls('w', 1, asc.nextCursor!, { agentId: 'paged', order: 'asc' })
        ).items.map((item) => item.id),
      ).toEqual(['page-b']);
      await expect(store.listCalls('w', 10, 'bad-cursor')).rejects.toMatchObject({
        code: 'invalid_cursor',
      });
      const binding = await store.createProviderBinding({
        workspaceId: 'w',
        label: 'New',
        provider: 'fixture',
        environment: 'test',
        credentialId: 'cred',
        config: {},
        kind: 'tts',
        pluginId: 'plugin.fixture',
      });
      expect(binding).toMatchObject({ kind: 'tts', pluginId: 'plugin.fixture' });
      expect(
        await store.updateProviderBinding('w', binding.id, {
          label: 'New',
          provider: 'different',
          environment: 'test',
          credentialId: 'cred',
          config: {},
        }),
      ).toMatchObject({ provider: 'different', kind: null, pluginId: null });
      await store.updateProviderBinding('w', binding.id, {
        label: 'New',
        provider: 'fixture',
        environment: 'test',
        credentialId: 'cred',
        config: {},
        kind: 'tts',
        pluginId: 'plugin.fixture',
      });
      expect(
        await store.updateProviderBinding('w', binding.id, {
          label: 'New',
          provider: 'fixture',
          environment: 'test',
          credentialId: 'cred',
          config: {},
          kind: null,
          pluginId: null,
        }),
      ).toMatchObject({ kind: null, pluginId: null });
    } finally {
      await store.close();
    }
  });
  it('preserves microseconds in Postgres call cursors', async () => {
    const store = await PostgresControlStore.open({
      connectionString: url!,
      options: `-c search_path=${schema}`,
    });
    try {
      const agent = await store.createAgent(
        'w',
        AgentConfig.parse({ name: 'Micro', mode: 'announcement', message: 'hello' }),
        'micro-agent',
      );
      const release = await store.createRelease({
        workspaceId: 'w',
        agent,
        plugins: [],
        createdBy: 'test',
        id: 'micro-release',
        selections: { engine: { pluginId: 'engine.fixture', version: '1.0.0', config: {} } },
      });
      await store.createCall({
        workspaceId: 'w',
        releaseId: release.id,
        kind: 'test',
        status: 'micro',
        id: 'micro-a',
      });
      await store.createCall({
        workspaceId: 'w',
        releaseId: release.id,
        kind: 'test',
        status: 'micro',
        id: 'micro-b',
      });
      await pool.query(
        "UPDATE ovo_ctl_calls SET created_at=CASE id WHEN 'micro-a' THEN '2025-01-01T00:00:00.000100Z'::timestamptz ELSE '2025-01-01T00:00:00.000900Z'::timestamptz END WHERE id IN ('micro-a','micro-b')",
      );
      const microDesc = await store.listCalls('w', 1, undefined, {
        agentId: 'micro-agent',
        status: 'micro',
      });
      expect(microDesc.items.map((item) => item.id)).toEqual(['micro-b']);
      expect(
        (
          await store.listCalls('w', 1, microDesc.nextCursor!, {
            agentId: 'micro-agent',
            status: 'micro',
          })
        ).items.map((item) => item.id),
      ).toEqual(['micro-a']);
      const microAsc = await store.listCalls('w', 1, undefined, {
        agentId: 'micro-agent',
        status: 'micro',
        order: 'asc',
      });
      expect(microAsc.items.map((item) => item.id)).toEqual(['micro-a']);
      expect(
        (
          await store.listCalls('w', 1, microAsc.nextCursor!, {
            agentId: 'micro-agent',
            status: 'micro',
            order: 'asc',
          })
        ).items.map((item) => item.id),
      ).toEqual(['micro-b']);
      expect(JSON.parse(Buffer.from(microDesc.nextCursor!, 'base64url').toString('utf8')).at).toBe(
        '2025-01-01T00:00:00.000900Z',
      );
    } finally {
      await store.close();
    }
  });
});
