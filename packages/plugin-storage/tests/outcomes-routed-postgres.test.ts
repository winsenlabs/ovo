import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MemoryCallOutcomeStore,
  PostgresCallOutcomeStore,
  runCallOutcomeMigrations,
} from '../src/outcomes/index.ts';
import { callOutcomesV1 } from '../src/outcomes/migrations.ts';
import { event } from './outcomes-fixture.ts';
import { ROUTED_CALL } from './outcomes-route-fixture.ts';
import { WINDOW, expectRoutedFilters, seedRoutedCalls } from './outcomes-routed-fixture.ts';
import { expectRouteStats } from './outcomes-routed-stats-fixture.ts';

const databaseUrl = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!databaseUrl)('PostgreSQL call outcomes: routed reads (v5)', () => {
  const schema = `ovo_outcomes_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let store: PostgresCallOutcomeStore;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
      max: 2,
    });
    // A store as Wave 14 left it: v1 applied, one finished call.
    await pool.query(callOutcomesV1);
    await pool.query(
      `CREATE TABLE ovo_outcome_schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
       INSERT INTO ovo_outcome_schema_migrations (version) VALUES (1);
       INSERT INTO ovo_call_outcomes (workspace_id, call_id, outcome, events, updated_at)
       VALUES ('ws-old', 'old-call', 'completed', 3, now());`,
    );
    store = new PostgresCallOutcomeStore(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });

  it('applies v5 over older data, creates the three indexes and reruns as a no-op', async () => {
    await runCallOutcomeMigrations(pool);
    await runCallOutcomeMigrations(pool);
    const versions = await pool.query(
      'SELECT version FROM ovo_outcome_schema_migrations ORDER BY version',
    );
    expect(versions.rows.map((row) => row.version)).toEqual([1, 2, 3, 4, 5]);
    const indexes = await pool.query(
      'SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname',
      [schema, 'ovo_call_outcomes'],
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'ovo_call_outcomes_route_point_idx',
        'ovo_call_outcomes_segments_idx',
        'ovo_call_outcomes_updated_idx',
      ]),
    );
    expect(await store.get('ws-old', 'old-call')).toMatchObject({
      outcome: 'completed',
      route: null,
    });
    // A call from before Wave 18 is no routed call, and the reads tolerate it.
    expect((await store.findRouted('ws-old', {})).items).toEqual([]);
    expect((await store.routeStats('ws-old', WINDOW)).totals.routed).toBe(0);
  });

  it('filters routed calls and pages them with a stable cursor', async () => {
    await expectRoutedFilters(store, `ws-${randomUUID()}`);
  });

  it('folds route stats', async () => {
    await expectRouteStats(store, `ws-${randomUUID()}`);
  });

  it('answers exactly what the memory store answers for the same calls', async () => {
    const workspaceId = `ws-agree-${randomUUID()}`;
    const memory = new MemoryCallOutcomeStore();
    await seedRoutedCalls(store, workspaceId);
    await seedRoutedCalls(memory, workspaceId);
    expect(await store.routeStats(workspaceId, WINDOW)).toEqual(
      await memory.routeStats(workspaceId, WINDOW),
    );
    for (const filter of [{}, { fallback: true }, { poolId: 'x' }, { human: false }])
      expect(await store.findRouted(workspaceId, filter, 3)).toEqual(
        await memory.findRouted(workspaceId, filter, 3),
      );
  });

  it('counts a call that routed before Wave 18 (no turns, no counts) without failing', async () => {
    const workspaceId = `ws-legacy-${randomUUID()}`;
    await store.append(
      workspaceId,
      'legacy',
      ROUTED_CALL.map(([t, p]) => event(t, p)),
    );
    await pool.query(
      `UPDATE ovo_call_outcomes SET route = route - 'turns' - 'routeMs' - 'fallbacks' - 'reasks' WHERE workspace_id = $1`,
      [workspaceId],
    );
    const stats = await store.routeStats(workspaceId, {
      since: '2026-10-06T00:00:00.000Z',
      until: '2026-10-07T00:00:00.000Z',
      bucket: 'day',
    });
    expect(stats.totals).toMatchObject({
      routed: 1,
      withFallback: 0,
      withReask: 0,
      routeMsP50: null,
    });
  });
});
