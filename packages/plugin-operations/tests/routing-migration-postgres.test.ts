import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import m001 from '../migrations/001_operations.sql?raw';
import m002 from '../migrations/002_live_launch.sql?raw';
import m003 from '../migrations/003_inbound_gateway.sql?raw';
import m004 from '../migrations/004_inbound_overflow.sql?raw';
import m005 from '../migrations/005_inbound_carrier.sql?raw';
import m006 from '../migrations/006_inbound_admission_carrier.sql?raw';
import m007 from '../migrations/007_campaign_pacing.sql?raw';
import m008 from '../migrations/008_outbound_compliance.sql?raw';
import m009 from '../migrations/009_india_compliance.sql?raw';
import m010 from '../migrations/010_routing.sql?raw';
import { PostgresOperationsService, runOperationsMigrations } from '../src/index.ts';
import { publishedRelease, releaseIds, routingSchema } from './routing-fixture.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
const organizationId = 'org-routing-migration';

describe.skipIf(!postgresUrl)('operations migration 010 (routing)', () => {
  let db: Awaited<ReturnType<typeof routingSchema>>;
  const direct = randomUUID();

  beforeAll(async () => {
    db = await routingSchema(postgresUrl!);
    // A database exactly as Wave 14 left it: 001-009 applied, one direct inbound route.
    await db.pool.query(
      'CREATE TABLE ovo_ops_schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const [index, sql] of [m001, m002, m003, m004, m005, m006, m007, m008, m009].entries()) {
      await db.pool.query(sql);
      await db.pool.query('INSERT INTO ovo_ops_schema_migrations (version) VALUES ($1)', [
        index + 1,
      ]);
    }
    await db.pool.query(
      `INSERT INTO ovo_ops_inbound_routes (organization_id, phone_number, release_id, variables)
       VALUES ($1, '+14155550100', $2, '{"tier":"gold"}'::jsonb)`,
      [organizationId, direct],
    );
  });

  afterAll(async () => db?.drop());

  it('applies 010 over pre-010 data, keeps the rows, and reruns as a no-op', async () => {
    await runOperationsMigrations(db.pool);
    const versions = await db.pool.query<{ version: number }>(
      'SELECT version FROM ovo_ops_schema_migrations ORDER BY version',
    );
    expect(versions.rows.map((row) => row.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    const operations = new PostgresOperationsService({ pool: db.pool, organizationId });
    expect(await operations.inboundRoutes.get('+14155550100')).toMatchObject({
      releaseId: direct,
      routingReleaseId: null,
      routing: null,
      variables: { tier: 'gold' },
    });
    await runOperationsMigrations(db.pool);
    // The SQL itself is idempotent too (a half-applied run re-executes it whole).
    await db.pool.query(m010);
    expect(await operations.inboundRoutes.get('+14155550100')).toMatchObject({ releaseId: direct });
  });

  it('holds exactly one target per number and refuses an unknown routing release', async () => {
    let next = 2000;
    const insert = (release: string | null, routing: string | null) =>
      db.pool.query(
        `INSERT INTO ovo_ops_inbound_routes (organization_id, phone_number, release_id, routing_release_id)
         VALUES ($1, $2, $3, $4)`,
        [organizationId, `+1415555${next++}`, release, routing],
      );
    await expect(insert(null, null)).rejects.toMatchObject({
      constraint: 'ovo_ops_inbound_routes_target_chk',
    });
    const operations = new PostgresOperationsService({ pool: db.pool, organizationId });
    const release = await publishedRelease(operations.routing, releaseIds());
    await expect(insert(randomUUID(), release.id)).rejects.toMatchObject({
      constraint: 'ovo_ops_inbound_routes_target_chk',
    });
    await expect(insert(null, randomUUID())).rejects.toMatchObject({
      constraint: 'ovo_ops_inbound_routes_routing_fk',
    });
    await expect(insert(null, release.id)).resolves.toMatchObject({ rowCount: 1 });
  });

  it('refuses any update or delete of a routing release', async () => {
    const operations = new PostgresOperationsService({ pool: db.pool, organizationId });
    const release = await publishedRelease(operations.routing, releaseIds());
    await expect(
      db.pool.query("UPDATE ovo_routing_releases SET created_by = 'x' WHERE id = $1", [release.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.pool.query('DELETE FROM ovo_routing_releases WHERE id = $1', [release.id]),
    ).rejects.toThrow(/immutable/);
    expect(await operations.routing.releases.get(release.id)).toEqual(release);
  });
});
