import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MemoryCallOutcomeStore,
  PostgresCallOutcomeStore,
  runCallOutcomeMigrations,
} from '../src/outcomes/index.ts';
import { callOutcomesV1, callOutcomesV2, callOutcomesV3 } from '../src/outcomes/migrations.ts';
import { event } from './outcomes-fixture.ts';
import {
  EXTERNAL_CALLBACKS,
  EXTERNAL_HUMAN_CALL,
  expectHumanOutcomes,
} from './outcomes-human-fixture.ts';

const databaseUrl = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!databaseUrl)('PostgreSQL call outcomes: human queues (v4)', () => {
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
    // A store exactly as Wave 16 left it: v1-v3 applied, one transferred call.
    for (const sql of [callOutcomesV1, callOutcomesV2, callOutcomesV3]) await pool.query(sql);
    await pool.query(
      `CREATE TABLE ovo_outcome_schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
       INSERT INTO ovo_outcome_schema_migrations (version) VALUES (1), (2), (3);
       INSERT INTO ovo_call_outcomes (workspace_id, call_id, outcome, events, updated_at, transfers)
       VALUES ('ws-old', 'old-call', 'completed', 3, now(), '{"requested": 1, "refused": 0, "connected": 1, "failed": 0}'::jsonb);`,
    );
    store = new PostgresCallOutcomeStore(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });

  it('adds the human column over v3 data and reruns as a no-op', async () => {
    await runCallOutcomeMigrations(pool);
    await runCallOutcomeMigrations(pool);
    const versions = await pool.query(
      'SELECT version FROM ovo_outcome_schema_migrations ORDER BY version',
    );
    expect(versions.rows.map((row) => row.version)).toEqual([1, 2, 3, 4]);
    expect(await store.get('ws-old', 'old-call')).toMatchObject({
      outcome: 'completed',
      human: null,
      transfers: { requested: 1, connected: 1 },
    });
    await expect(
      pool.query(`UPDATE ovo_call_outcomes SET human = '[]'::jsonb WHERE call_id = 'old-call'`),
    ).rejects.toThrow(/check/i);
  });

  it('folds the managed and external flows in PostgreSQL', async () => {
    await expectHumanOutcomes(store, `ws-${randomUUID()}`);
  });

  it('stores no human row for a call that never asked for a person', async () => {
    const workspaceId = `ws-${randomUUID()}`;
    await store.append(workspaceId, 'plain', [
      event('call.outcome', { outcome: 'completed', reason: 'x' }),
    ]);
    await store.append(
      workspaceId,
      'asked',
      EXTERNAL_HUMAN_CALL.map(([type, payload]) => event(type, payload)),
    );
    const rows = await pool.query(
      'SELECT call_id, human IS NULL AS none FROM ovo_call_outcomes WHERE workspace_id = $1 ORDER BY call_id',
      [workspaceId],
    );
    expect(rows.rows).toEqual([
      { call_id: 'asked', none: false },
      { call_id: 'plain', none: true },
    ]);
  });

  it('agrees with the memory store event for event, callbacks after the call ended', async () => {
    const memory = new MemoryCallOutcomeStore();
    const events = [...EXTERNAL_HUMAN_CALL, ...EXTERNAL_CALLBACKS].map(([type, payload]) =>
      event(type, payload),
    );
    for (const batch of [events.slice(0, 6), events.slice(6, 9), events.slice(9)]) {
      await store.append('ws-agree-v4', 'call', batch);
      await memory.append('ws-agree-v4', 'call', batch);
      expect(await store.get('ws-agree-v4', 'call')).toEqual(
        await memory.get('ws-agree-v4', 'call'),
      );
    }
    expect((await store.get('ws-agree-v4', 'call'))!.human!.callbacks.outcome).toBe('answered');
  });
});
