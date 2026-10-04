import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { runControlMigrations } from '../src/index.ts';
import { controlSchemaV1 } from '../src/postgres/migrations/001-control-schema.ts';
import { releaseProviderBindingsV2 } from '../src/postgres/migrations/002-release-provider-bindings.ts';
import { releaseMcpToolsV3 } from '../src/postgres/migrations/003-release-mcp-tools.ts';
import { releaseSelectionsV4 } from '../src/postgres/migrations/004-release-selections.ts';
import { callKindConstraintV5 } from '../src/postgres/migrations/005-call-kind-constraint.ts';
import { mcpToolRemovedV7 } from '../src/postgres/migrations/007-mcp-tool-removed.ts';
import { migrationChecksum } from '../src/postgres/shared.ts';

const url = process.env.OVO_TEST_POSTGRES_URL;

(url ? it : it.skip)(
  'refuses a missing lower migration before applying it under a recorded higher version',
  async () => {
    const schema = `control_gap_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: url! });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({ connectionString: url!, options: `-c search_path=${schema}` });
    try {
      await pool.query(
        'CREATE TABLE ovo_control_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())',
      );
      for (const migration of [
        { version: 1, name: 'control-schema', sql: controlSchemaV1 },
        { version: 2, name: 'release-provider-bindings', sql: releaseProviderBindingsV2 },
        { version: 3, name: 'release-mcp-tools', sql: releaseMcpToolsV3 },
        { version: 4, name: 'release-selections', sql: releaseSelectionsV4 },
        { version: 5, name: 'call-kind-constraint', sql: callKindConstraintV5 },
      ]) {
        await pool.query(migration.sql);
        await pool.query(
          'INSERT INTO ovo_control_schema_migrations(version,name,checksum) VALUES($1,$2,$3)',
          [migration.version, migration.name, migrationChecksum(migration.sql)],
        );
      }
      await pool.query(
        'INSERT INTO ovo_control_schema_migrations(version,name,checksum) VALUES($1,$2,$3)',
        [7, 'mcp-tool-removed', migrationChecksum(mcpToolRemovedV7)],
      );
      await expect(runControlMigrations(pool)).rejects.toThrow(
        'Control migration 6 is missing before recorded version 7',
      );
      expect(
        (
          await pool.query('SELECT version FROM ovo_control_schema_migrations ORDER BY version')
        ).rows.map((row) => row.version),
      ).toEqual([1, 2, 3, 4, 5, 7]);
      expect(
        (
          await pool.query(
            "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='ovo_ctl_releases' AND column_name='purpose'",
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
