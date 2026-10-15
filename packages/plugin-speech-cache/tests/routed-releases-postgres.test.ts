import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresOperationsService } from '../../plugin-operations/src/index.ts';
import { publishedRelease, releaseIds } from '../../plugin-operations/tests/routing-fixture.ts';
import { PostgresSpeechPrerenderQueue, runSpeechClipMigrations } from '../src/postgres/index.ts';

const databaseUrl = process.env.OVO_TEST_POSTGRES_URL;

/** Wave 15: pre-render every agent a routed number can hand a caller to, and skip NULL ids. */
describe.skipIf(!databaseUrl)('pre-render queue: routed releases with routing', () => {
  const schema = `ovo_prerender_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
      max: 4,
    });
    await runSpeechClipMigrations(pool);
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });

  it('adds the pinned releases of routed numbers and ignores routes without a release id', async () => {
    const operations = new PostgresOperationsService({ pool, organizationId: 'ws' });
    await operations.migrate();
    const ids = releaseIds();
    const release = await publishedRelease(operations.routing, ids);
    const direct = randomUUID();
    await operations.inboundRoutes.put({
      phoneNumber: '+14155550101',
      releaseId: direct,
      expectedVersion: null,
    });
    await operations.inboundRoutes.put({
      phoneNumber: '+14155550102',
      routingReleaseId: release.id,
      expectedVersion: null,
    });
    const queue = new PostgresSpeechPrerenderQueue(pool);
    expect(await queue.routedReleases()).toEqual(
      [direct, ids.router, ids.fallback, ids.en, ids.hi]
        .sort()
        .map((releaseId) => ({ workspaceId: 'ws', releaseId })),
    );
    // A disabled routed number contributes nothing.
    await operations.inboundRoutes.put({
      phoneNumber: '+14155550102',
      routingReleaseId: release.id,
      enabled: false,
      expectedVersion: 1,
    });
    expect(await queue.routedReleases()).toEqual([{ workspaceId: 'ws', releaseId: direct }]);
  });
});
