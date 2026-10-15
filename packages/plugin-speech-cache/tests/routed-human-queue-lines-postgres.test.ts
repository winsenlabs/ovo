import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HumanQueueDefinition,
  RoutingReleaseSnapshot,
  TRANSFER_BUILT_IN_LINES,
} from '@winsendotai/ovo-contracts';
import {
  PostgresOperationsService,
  routingSnapshotDigest,
} from '../../plugin-operations/src/index.ts';
import {
  releaseIds,
  salesDraft,
  salesPool,
  salesSnapshot,
} from '../../plugin-operations/tests/routing-fixture.ts';
import { PostgresSpeechPrerenderQueue, runSpeechClipMigrations } from '../src/postgres/index.ts';

const databaseUrl = process.env.OVO_TEST_POSTGRES_URL;

/** Wave 17: the queue announcements, hold lines and human built-ins a worker pre-renders. */
describe.skipIf(!databaseUrl)('pre-render queue: human queue lines per release', () => {
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

  it('gives the router the queue announcement and hold lines, and a granted agent the target announcement', async () => {
    const operations = new PostgresOperationsService({
      pool,
      organizationId: 'ws',
      config: { permittedFromNumbers: [], routingEnabled: true, humanQueueEnabled: true },
    });
    await operations.migrate();
    const ids = releaseIds();
    const salesPoolRow = await operations.routing.pools.create(salesPool(ids, 'Sales R3'));
    const point = await operations.routing.points.create(salesDraft(salesPoolRow.id, 'Main R3'));
    const queue = await operations.humanQueues.queues.create(
      HumanQueueDefinition.parse({
        kind: 'managed',
        name: 'Floor',
        announcement: { en: 'Putting you through to a person.' },
        hold: {
          steps: [
            { kind: 'silence', seconds: 2 },
            { kind: 'line', line: { en: 'Still with you, one moment.' } },
          ],
          onTimeout: [{ kind: 'end', line: { en: 'No one is free. Goodbye.' } }],
        },
      }),
    );
    const base = salesSnapshot(point.id, salesPoolRow.id, ids);
    const snapshot = RoutingReleaseSnapshot.parse({
      ...base,
      schemaVersion: 3,
      humanQueues: [{ key: 'floor', queueId: queue.id, priority: 0 }],
      queues: {
        [queue.id]: {
          id: queue.id,
          version: 1,
          key: 'floor',
          priority: 0,
          definition: queue.definition,
        },
      },
      nodes: base.nodes.map((node) => ({
        ...node,
        fallback: [{ kind: 'human', queueId: 'floor' }, ...node.fallback],
      })),
      transfer: {
        targets: [
          {
            key: 'person',
            description: 'A person',
            destination: { kind: 'human', queueId: 'floor' },
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
      phoneNumber: '+14155550301',
      routingReleaseId: release!.id,
      expectedVersion: null,
    });
    const prerender = new PostgresSpeechPrerenderQueue(pool);
    const router = await prerender.routedVoiceLines('ws', ids.router);
    expect(router).toEqual(
      expect.arrayContaining([
        'Putting you through to a person.',
        'Still with you, one moment.',
        'No one is free. Goodbye.',
        TRANSFER_BUILT_IN_LINES.human.en,
        TRANSFER_BUILT_IN_LINES.callback.en,
        TRANSFER_BUILT_IN_LINES.hold.en,
      ]),
    );
    expect(new Set(router).size).toBe(router.length);
    // The English pool member is granted the catalogue target: it announces the queue's line.
    expect(await prerender.routedVoiceLines('ws', ids.en)).toEqual(
      expect.arrayContaining(['Putting you through to a person.']),
    );
    // A disabled number contributes nothing.
    await operations.inboundRoutes.put({
      phoneNumber: '+14155550301',
      routingReleaseId: release!.id,
      enabled: false,
      expectedVersion: 1,
    });
    expect(await prerender.routedVoiceLines('ws', ids.router)).toEqual([]);
  });
});
