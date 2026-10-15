import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MemoryCallOutcomeStore,
  PostgresCallOutcomeStore,
  runCallOutcomeMigrations,
} from '../src/outcomes/index.ts';
import { callOutcomesV1, callOutcomesV2 } from '../src/outcomes/migrations.ts';
import { event } from './outcomes-fixture.ts';
import { expectTransferOutcomes, TRANSFERRED_CALL } from './outcomes-transfer-fixture.ts';

const databaseUrl = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!databaseUrl)('PostgreSQL call outcomes: segments and transfers (v3)', () => {
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
    // A store exactly as Wave 15 left it: v1 and v2 applied, one routed call.
    await pool.query(callOutcomesV1);
    await pool.query(callOutcomesV2);
    await pool.query(
      `CREATE TABLE ovo_outcome_schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
       INSERT INTO ovo_outcome_schema_migrations (version) VALUES (1), (2);
       INSERT INTO ovo_call_outcomes (workspace_id, call_id, outcome, events, updated_at, route)
       VALUES ('ws-old', 'old-call', 'completed', 3, now(), '{"segments": 2}'::jsonb);`,
    );
    store = new PostgresCallOutcomeStore(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });

  it('adds segments and transfers over v2 data and reruns as a no-op', async () => {
    await runCallOutcomeMigrations(pool);
    await runCallOutcomeMigrations(pool);
    const versions = await pool.query(
      'SELECT version FROM ovo_outcome_schema_migrations ORDER BY version',
    );
    expect(versions.rows.map((row) => row.version)).toEqual([1, 2, 3, 4]);
    expect(await store.get('ws-old', 'old-call')).toMatchObject({
      outcome: 'completed',
      segments: [],
      transfers: { requested: 0, refused: 0, connected: 0, failed: 0 },
    });
    await expect(
      pool.query(`UPDATE ovo_call_outcomes SET segments = '{}'::jsonb WHERE call_id = 'old-call'`),
    ).rejects.toThrow(/check/i);
    await expect(
      pool.query(`UPDATE ovo_call_outcomes SET transfers = '[]'::jsonb WHERE call_id = 'old-call'`),
    ).rejects.toThrow(/check/i);
  });

  it('folds segments and transfers in PostgreSQL', async () => {
    await expectTransferOutcomes(store, `ws-${randomUUID()}`);
  });

  it('stores no transfers row for a call without transfer events', async () => {
    const workspaceId = `ws-${randomUUID()}`;
    await store.append(workspaceId, 'plain', [
      event('call.outcome', { outcome: 'completed', reason: 'x' }),
    ]);
    await store.append(
      workspaceId,
      'moved',
      TRANSFERRED_CALL.map(([type, payload]) => event(type, payload)),
    );
    const rows = await pool.query(
      'SELECT call_id, transfers FROM ovo_call_outcomes WHERE workspace_id = $1 ORDER BY call_id',
      [workspaceId],
    );
    expect(rows.rows).toEqual([
      { call_id: 'moved', transfers: { requested: 2, refused: 1, connected: 1, failed: 0 } },
      { call_id: 'plain', transfers: null },
    ]);
  });

  it('agrees with the memory store event for event, across batches', async () => {
    const memory = new MemoryCallOutcomeStore();
    const events = TRANSFERRED_CALL.map(([type, payload]) => event(type, payload));
    for (const batch of [events.slice(0, 3), events.slice(3, 8), events.slice(8)]) {
      await store.append('ws-agree-v3', 'call', batch);
      await memory.append('ws-agree-v3', 'call', batch);
      expect(await store.get('ws-agree-v3', 'call')).toEqual(
        await memory.get('ws-agree-v3', 'call'),
      );
    }
    expect((await store.get('ws-agree-v3', 'call'))!.segments).toHaveLength(3);
  });
});
