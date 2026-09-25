import type { Pool } from 'pg';
import { controlSchemaV1 } from './migrations/001-control-schema.ts';
import { releaseProviderBindingsV2 } from './migrations/002-release-provider-bindings.ts';
import { releaseMcpToolsV3 } from './migrations/003-release-mcp-tools.ts';
import { releaseSelectionsV4 } from './migrations/004-release-selections.ts';
import { callKindConstraintV5 } from './migrations/005-call-kind-constraint.ts';
import { migrationChecksum, transaction } from './shared.ts';

const migrations = [
  { version: 1, name: 'control-schema', sql: controlSchemaV1 },
  { version: 2, name: 'release-provider-bindings', sql: releaseProviderBindingsV2 },
  { version: 3, name: 'release-mcp-tools', sql: releaseMcpToolsV3 },
  { version: 4, name: 'release-selections', sql: releaseSelectionsV4 },
  { version: 5, name: 'call-kind-constraint', sql: callKindConstraintV5 },
] as const;

const legacyKindDefinition = "CHECK ((kind = ANY (ARRAY['live'::text, 'simulation'::text])))";
const legacyKindFragment = "kind = ANY (ARRAY['live'::text, 'simulation'::text])";

/** The historical v4 SQL is immutable; keep its broad lookup from losing custom checks. */
async function protectLegacyV4(client: import('pg').PoolClient): Promise<void> {
  const result = await client.query<{ conname: string; definition: string }>(
    `SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
     WHERE conrelid='ovo_ctl_calls'::regclass AND contype='c'
       AND pg_get_constraintdef(oid) LIKE '%kind%'`,
  );
  for (const constraint of result.rows) {
    if (
      constraint.definition.includes(legacyKindFragment) &&
      constraint.definition !== legacyKindDefinition
    )
      throw new Error(`compound call-kind constraint ${constraint.conname} needs manual review`);
  }
}

export async function runControlMigrations(pool: Pool): Promise<void> {
  for (const migration of migrations) {
    await transaction(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('ovo-control-migrations-v1'))");
      await client.query(`
        CREATE TABLE IF NOT EXISTS ovo_control_schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          checksum TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
        )
      `);
      const checksum = migrationChecksum(migration.sql);
      const applied = await client.query<{ checksum: string }>(
        'SELECT checksum FROM ovo_control_schema_migrations WHERE version=$1',
        [migration.version],
      );
      if (applied.rowCount) {
        if (applied.rows[0]!.checksum !== checksum)
          throw new Error(`Control migration ${migration.version} checksum changed`);
        return;
      }
      if (migration.version === 4) await protectLegacyV4(client);
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO ovo_control_schema_migrations(version,name,checksum) VALUES($1,$2,$3)',
        [migration.version, migration.name, checksum],
      );
    });
  }
}
