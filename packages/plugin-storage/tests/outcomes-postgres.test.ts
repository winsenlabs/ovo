import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, expect, it, describe } from 'vitest';
import {
  PostgresCallOutcomeStore,
  QueuedSessionEventSink,
  runCallOutcomeMigrations,
} from '../src/outcomes/index.ts';
import { COLLECTIONS_CALL, expectCollectionsOutcome } from './outcomes-fixture.ts';

const databaseUrl = process.env.OVO_TEST_POSTGRES_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('PostgreSQL call outcomes (AGT-8)', () => {
  let store: PostgresCallOutcomeStore;
  let pool: pg.Pool;

  beforeAll(async () => {
    store = await PostgresCallOutcomeStore.open({ connectionString: databaseUrl! });
    pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    await runCallOutcomeMigrations(pool); // idempotent: a second run applies nothing
  });
  afterAll(async () => {
    await store.close();
    await pool.end();
  });

  it('stores the event log and the folded outcome in one transaction, workspace scoped', async () => {
    await expectCollectionsOutcome(store, `ws-${randomUUID()}`);
  });

  it('orders concurrent writers to one call without gaps or lost summary updates', async () => {
    const workspaceId = `ws-${randomUUID()}`;
    const sinks = Array.from(
      { length: 4 },
      () => new QueuedSessionEventSink(store, { workspaceId, callId: 'call' }),
    );
    await Promise.all(
      sinks.map(async (sink, index) => {
        for (let turn = 0; turn < 5; turn += 1)
          await sink.append('turn.route', { turn, tier: index % 2 ? 'jev' : 'rule' });
        await sink.flush();
      }),
    );
    const page = await store.listEvents(workspaceId, 'call', 100);
    expect(page.items.map((item) => item.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(await store.get(workspaceId, 'call')).toMatchObject({
      events: 20,
      tiers: { rule: 10, jev: 10 },
    });
  });

  it('writes a whole call through the queued sink', async () => {
    const workspaceId = `ws-${randomUUID()}`;
    const sink = new QueuedSessionEventSink(store, { workspaceId, callId: 'sink-call' });
    for (const [type, payload] of COLLECTIONS_CALL) await sink.append(type, payload);
    await sink.flush();
    expect(sink.stats()).toMatchObject({ written: COLLECTIONS_CALL.length, dropped: 0 });
    const row = await pool.query(
      'SELECT disposition, final_node, state_path FROM ovo_call_outcomes WHERE workspace_id=$1',
      [workspaceId],
    );
    expect(row.rows).toEqual([
      {
        disposition: 'promise_to_pay',
        final_node: 'goodbye',
        state_path: ['identity', 'disclose', 'ptp_tomorrow', 'goodbye'],
      },
    ]);
  });
});
