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
import { ROUTED_CALL, expectRoutedOutcomes } from './outcomes-route-fixture.ts';

const databaseUrl = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!databaseUrl)('PostgreSQL call outcomes: route (v2)', () => {
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
    // A store exactly as Wave 14 left it: v1 applied, one finished call.
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

  it('adds the route column over v1 data and reruns as a no-op', async () => {
    await runCallOutcomeMigrations(pool);
    await runCallOutcomeMigrations(pool);
    const versions = await pool.query(
      'SELECT version FROM ovo_outcome_schema_migrations ORDER BY version',
    );
    expect(versions.rows.map((row) => row.version)).toEqual([1, 2, 3, 4, 5]);
    expect(await store.get('ws-old', 'old-call')).toMatchObject({
      outcome: 'completed',
      route: null,
      events: 3,
    });
    await expect(
      pool.query(`UPDATE ovo_call_outcomes SET route = '[]'::jsonb WHERE call_id = 'old-call'`),
    ).rejects.toThrow(/check/i);
  });

  it('folds route events in PostgreSQL', async () => {
    await expectRoutedOutcomes(store, `ws-${randomUUID()}`);
  });

  it('agrees with the memory store event for event, across batches', async () => {
    const memory = new MemoryCallOutcomeStore();
    const events = ROUTED_CALL.map(([type, payload]) => event(type, payload));
    for (const batch of [events.slice(0, 2), events.slice(2, 4), events.slice(4)]) {
      await store.append('ws-agree', 'call', batch);
      await memory.append('ws-agree', 'call', batch);
      expect(await store.get('ws-agree', 'call')).toEqual(await memory.get('ws-agree', 'call'));
    }
    expect((await store.get('ws-agree', 'call'))!.route!.segments).toBe(2);
  });
});
