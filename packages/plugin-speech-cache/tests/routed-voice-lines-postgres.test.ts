import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RoutingReleaseSnapshot, TRANSFER_BUILT_IN_LINES } from '@winsendotai/ovo-contracts';
import {
  PostgresOperationsService,
  routingSnapshotDigest,
} from '../../plugin-operations/src/index.ts';
import {
  publishedRelease,
  releaseIds,
  salesDraft,
  salesPool,
  salesSnapshot,
} from '../../plugin-operations/tests/routing-fixture.ts';
import { PostgresSpeechPrerenderQueue, runSpeechClipMigrations } from '../src/postgres/index.ts';

const databaseUrl = process.env.OVO_TEST_POSTGRES_URL;

/** Wave 16: the routed voice lines a worker pre-renders for each release of a routed number. */
describe.skipIf(!databaseUrl)('pre-render queue: routed voice lines per release', () => {
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

  it('lists nothing before operations exist', async () => {
    expect(
      await new PostgresSpeechPrerenderQueue(pool).routedVoiceLines('ws', randomUUID()),
    ).toEqual([]);
  });

  it('gives the router its lines and a granted agent its transfer lines, for enabled numbers only', async () => {
    const operations = new PostgresOperationsService({ pool, organizationId: 'ws' });
    await operations.migrate();
    const ids = releaseIds();
    const salesPoolRow = await operations.routing.pools.create(salesPool(ids, 'Sales R2'));
    const point = await operations.routing.points.create(salesDraft(salesPoolRow.id, 'Main R2'));
    const announcement = 'Let me transfer you. Please stay on the line.';
    const snapshot = RoutingReleaseSnapshot.parse({
      ...salesSnapshot(point.id, salesPoolRow.id, ids),
      schemaVersion: 2,
      transfer: {
        announcement: { en: announcement },
        targets: [
          {
            key: 'senior',
            description: 'A senior colleague',
            confirm: 'ask',
            destination: { kind: 'same-pool', skills: [] },
          },
        ],
      },
    });
    const release = await operations.routing.releases.create({
      pointId: point.id,
      draftVersion: point.draftVersion,
      snapshot,
      digest: routingSnapshotDigest(snapshot),
      createdBy: 'user:tester',
    });
    await operations.inboundRoutes.put({
      phoneNumber: '+14155550201',
      routingReleaseId: release!.id,
      expectedVersion: null,
    });
    // Another routed number on an R1 release that shares the router: its lines merge in.
    const r1 = await publishedRelease(operations.routing, { ...releaseIds(), router: ids.router });
    await operations.inboundRoutes.put({
      phoneNumber: '+14155550202',
      routingReleaseId: r1.id,
      expectedVersion: null,
    });
    const queue = new PostgresSpeechPrerenderQueue(pool);
    const router = await queue.routedVoiceLines('ws', ids.router);
    expect(router).toContain('Welcome. How can I help you today?');
    expect(router).toContain('Are you calling about sales?');
    expect(router).toContain(TRANSFER_BUILT_IN_LINES.hold.en);
    expect(router).not.toContain(announcement);
    expect(new Set(router).size).toBe(router.length);
    const english = await queue.routedVoiceLines('ws', ids.en);
    expect(english).toEqual([
      announcement,
      TRANSFER_BUILT_IN_LINES.queue.en,
      'Shall I transfer you to senior?',
    ]);
    // The Hindi member hears no English transfer lines (it speaks hi only; no hi lines authored),
    // but the built-in Hindi queue line and confirm question are its own.
    expect(await queue.routedVoiceLines('ws', ids.hi)).toEqual([
      TRANSFER_BUILT_IN_LINES.queue.hi,
      'क्या मैं आपको senior से जोड़ दूँ?',
    ]);
    expect(await queue.routedVoiceLines('other-ws', ids.router)).toEqual([]);
    expect(await queue.routedVoiceLines('ws', randomUUID())).toEqual([]);
    expect(await queue.routedVoiceLines('ws', 'not-a-uuid')).toEqual([]);
    // A disabled number contributes nothing.
    await operations.inboundRoutes.put({
      phoneNumber: '+14155550201',
      routingReleaseId: release!.id,
      enabled: false,
      expectedVersion: 1,
    });
    expect(await queue.routedVoiceLines('ws', ids.en)).toEqual([]);
  });
});
