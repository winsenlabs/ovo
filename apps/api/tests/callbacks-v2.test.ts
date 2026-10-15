import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgresCallOutcomeStore,
  runCallOutcomeMigrations,
} from '@winsendotai/ovo-plugin-storage/outcomes';
import { PostgresOrchestrationStore } from '../../../packages/plugin-orchestration/src/index.ts';
import { CALLBACK_SCHEMA_VERSIONS } from '../src/callback-migrations.ts';
import {
  dialFromJob,
  PostgresCallbackStore,
  runCallbackMigrations,
} from '../src/callback-store.ts';
import { CallbackService, registerCallbackRoutes } from '../src/routes/callbacks.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;

describe('dialFromJob with a stamped release (routing, design 5.5)', () => {
  const job = { kind: 'inbound_call', releaseId: 'router', from: '+919800000001', to: '+9180' };

  it('dials the release that promised the callback, else the call release', () => {
    expect(dialFromJob(job, 'agent')?.releaseId).toBe('agent');
    expect(dialFromJob(job, null)?.releaseId).toBe('router');
    expect(dialFromJob(job)?.releaseId).toBe('router');
  });
});

describe.skipIf(!postgresUrl)('callbacks schema v2 in PostgreSQL (routing, design 5.5)', () => {
  // A schema of its own, so the v1 database this starts from is not the shared one.
  const schema = `callbacks_v2_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({
    connectionString: postgresUrl,
    max: 3,
    options: `-c search_path=${schema}`,
  });
  const workspaceId = `callbacks-v2-${randomUUID()}`;

  const constraints = async () =>
    (
      await pool.query<{ name: string; definition: string }>(
        `SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE conrelid = 'ovo_callbacks'::regclass AND contype = 'c' ORDER BY conname`,
      )
    ).rows;
  const insert = (source: string, callId = randomUUID()) =>
    pool.query(
      `INSERT INTO ovo_callbacks (id, workspace_id, call_id, event_id, due_at, timezone, source)
       VALUES ($1, $2, $3, 'e1', now(), 'Asia/Kolkata', $4)`,
      [randomUUID(), workspaceId, callId, source],
    );

  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA ${schema}`);
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  });

  it('upgrades a v1 database in place: rows kept, release_id added, route accepted', async () => {
    // The v1 database exactly as v1 left it: its statements and its ledger row.
    await runCallOutcomeMigrations(pool);
    await pool.query(
      'CREATE TABLE ovo_callback_schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const statement of CALLBACK_SCHEMA_VERSIONS[0]!) await pool.query(statement);
    await pool.query('INSERT INTO ovo_callback_schema_migrations (version) VALUES (1)');
    // The generated name of v1's inline CHECK, which v2 drops by name.
    expect((await constraints()).map((row) => row.name)).toEqual([
      'ovo_callbacks_source_check',
      'ovo_callbacks_status_check',
    ]);
    const kept = randomUUID();
    await insert('flow', kept);
    await expect(insert('route')).rejects.toThrow(/ovo_callbacks_source_check/);

    await runCallbackMigrations(pool);
    await runCallbackMigrations(pool);

    const versions = await pool.query<{ version: number }>(
      'SELECT version FROM ovo_callback_schema_migrations ORDER BY version',
    );
    expect(versions.rows.map((row) => row.version)).toEqual([1, 2]);
    const source = (await constraints()).filter((row) => row.name.includes('source'));
    expect(source).toHaveLength(1);
    expect(source[0]!.definition).toContain("'route'");
    const row = await pool.query(
      'SELECT source, release_id FROM ovo_callbacks WHERE call_id = $1',
      [kept],
    );
    expect(row.rows).toEqual([{ source: 'flow', release_id: null }]);
    await insert('route');
    await expect(insert('operator')).rejects.toThrow(/ovo_callbacks_source_check/);
    await pool.query('DELETE FROM ovo_callbacks WHERE workspace_id = $1', [workspaceId]);
  });

  describe('sync and dial', () => {
    const callId = randomUUID();
    const routerRelease = randomUUID();
    const agentRelease = randomUUID();
    const placed: Record<string, unknown>[] = [];
    let app: FastifyInstance;
    let outcomes: PostgresCallOutcomeStore;
    const callback = (id: string, dueAt: string, extra: Record<string, unknown>) => ({
      id,
      at: '2026-10-15T08:00:00.000Z',
      type: 'disposition',
      payload: {
        disposition: 'callback',
        callback: { dueAt, timezone: 'Asia/Kolkata', ...extra },
      },
    });

    beforeAll(async () => {
      await runCallbackMigrations(pool);
      await new PostgresOrchestrationStore(pool).migrate();
      await pool.query(
        `INSERT INTO ovo_jobs (id, workspace_id, idempotency_key, payload, status)
         VALUES ($1,$2,$3,$4::jsonb,'completed')`,
        [
          callId,
          workspaceId,
          callId,
          JSON.stringify({
            kind: 'inbound_call',
            releaseId: routerRelease,
            from: '+919800000001',
            to: '+918040000000',
            variables: {},
          }),
        ],
      );
      outcomes = new PostgresCallOutcomeStore(pool);
      await outcomes.append(workspaceId, callId, [
        // The routed agent promised it and the worker stamped its release.
        callback('e1', '2026-10-15T10:00:00.000Z', {
          source: 'route',
          node: 'intent',
          releaseId: agentRelease,
        }),
        // A callback from before routing: no release, the call's own is dialled.
        callback('e2', '2026-10-15T11:00:00.000Z', { source: 'flow' }),
        // A stamp that is not a release id never fails the sync and is not kept.
        callback('e3', '2026-10-15T12:00:00.000Z', { source: 'route', releaseId: 'nope' }),
        // An unknown source is still skipped.
        callback('e4', '2026-10-15T13:00:00.000Z', { source: 'operator' }),
      ]);
      app = Fastify({ logger: false });
      registerCallbackRoutes({
        app,
        callbacks: new CallbackService(async () => new PostgresCallbackStore(pool)),
        requireRole: () => ({ workspaceId, identityId: 'operator' }),
        error: (reply, status, code, message) =>
          reply.code(status).send({ error: { code, message } }),
      });
      app.post('/v1/calls', async (request, reply) => {
        placed.push(request.body as Record<string, unknown>);
        return reply
          .code(202)
          .send({ callId: (request.body as { operationId: string }).operationId });
      });
    });

    afterAll(async () => {
      await app.close();
    });

    it('keeps route callbacks with the release that promised them', async () => {
      const listed = (await app.inject({ method: 'GET', url: '/v1/callbacks' })).json();
      expect(
        listed.items.map((item: Record<string, unknown>) => [item.source, item.releaseId]),
      ).toEqual([
        ['route', agentRelease],
        ['flow', null],
        ['route', null],
      ]);
    });

    it('dials COALESCE(callback.release_id, call.release_id)', async () => {
      const { items } = (await app.inject({ method: 'GET', url: '/v1/callbacks' })).json();
      for (const item of items.slice(0, 2)) {
        const dialed = await app.inject({ method: 'POST', url: `/v1/callbacks/${item.id}/dial` });
        expect(dialed.statusCode, dialed.body).toBe(202);
      }
      expect(placed.map((body) => body.releaseId)).toEqual([agentRelease, routerRelease]);
      expect(placed[0]).toMatchObject({ to: '+919800000001', fromNumber: '+918040000000' });
    });
  });
});
