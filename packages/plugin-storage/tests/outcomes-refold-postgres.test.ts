import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresCallOutcomeStore, runCallOutcomeMigrations } from '../src/outcomes/index.ts';
import { SEEDED, seedRoutedCalls } from './outcomes-routed-fixture.ts';

const databaseUrl = process.env.OVO_TEST_POSTGRES_URL;
/** What a route looked like before Wave 18: none of the fields the fold added. */
const STRIP = `route = route - 'turns' - 'routeMs' - 'fallbacks' - 'reasks'`;

describe.skipIf(!databaseUrl)('refolding routes recorded before Wave 18', () => {
  const schema = `ovo_outcomes_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let store: PostgresCallOutcomeStore;
  const decided = Object.keys(SEEDED).filter((id) => !['c-undec', 'c-direct'].includes(id));

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
      max: 3,
    });
    await runCallOutcomeMigrations(pool);
    store = new PostgresCallOutcomeStore(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });

  async function legacy(workspaceId: string) {
    await seedRoutedCalls(store, workspaceId);
    const original = new Map<string, unknown>();
    for (const callId of Object.keys(SEEDED))
      original.set(callId, (await store.get(workspaceId, callId))!.route);
    await pool.query(
      `UPDATE ovo_call_outcomes SET ${STRIP} WHERE workspace_id = $1 AND route IS NOT NULL`,
      [workspaceId],
    );
    return original;
  }
  const routeOf = async (workspaceId: string, callId: string) =>
    (await store.get(workspaceId, callId))!.route;

  it('reports what would change in a dry run and writes nothing', async () => {
    const workspaceId = `ws-dry-${randomUUID()}`;
    const original = await legacy(workspaceId);
    const report = await store.refoldRoutes(workspaceId);
    expect(report).toMatchObject({ scanned: 6, unchanged: 0, failed: [], applied: 0 });
    expect(report.changed.map((call) => call.callId).sort()).toEqual([...decided].sort());
    const hi = report.changed.find((call) => call.callId === 'c-hi')!;
    expect(hi.before).not.toHaveProperty('routeMs');
    expect(hi.after).toEqual(original.get('c-hi'));
    expect(hi.after).toMatchObject({ turns: 2, routeMs: 2_000, fallbacks: 0, reasks: 1 });
    // Nothing was written.
    expect(await routeOf(workspaceId, 'c-hi')).not.toHaveProperty('routeMs');
  });

  it('applies it: each route comes back exactly, nothing else changes, and a second run finds nothing', async () => {
    const workspaceId = `ws-apply-${randomUUID()}`;
    const original = await legacy(workspaceId);
    const summaryBefore = await store.get(workspaceId, 'c-xfer');
    const report = await store.refoldRoutes(workspaceId, { apply: true });
    expect(report).toMatchObject({ scanned: 6, applied: 6, failed: [] });
    for (const callId of decided)
      expect(await routeOf(workspaceId, callId), callId).toEqual(original.get(callId));
    // Only the route column was written: the rest of the summary, and when it last changed, are as they were.
    const { route: _, ...rest } = (await store.get(workspaceId, 'c-xfer'))!;
    const { route: __, ...restBefore } = summaryBefore!;
    expect(rest).toEqual(restBefore);
    // A call that hung up while routing, and a direct call, are not looked at.
    expect(await routeOf(workspaceId, 'c-undec')).toEqual(original.get('c-undec'));
    expect(await routeOf(workspaceId, 'c-direct')).toBeNull();
    const again = await store.refoldRoutes(workspaceId, { apply: true });
    expect(again).toMatchObject({ scanned: 0, changed: [], applied: 0 });
    // The refolded calls now answer the stats and filters.
    const found = await store.findRouted(workspaceId, { fallback: true });
    expect(found.items.map((item) => item.callId).sort()).toEqual(['c-def', 'c-end']);
  });

  it('honours limit and since, and leaves another workspace alone', async () => {
    const workspaceId = `ws-limit-${randomUUID()}`;
    const other = `ws-other-${randomUUID()}`;
    await legacy(workspaceId);
    await legacy(other);
    expect((await store.refoldRoutes(workspaceId, { limit: 2 })).scanned).toBe(2);
    expect(
      (await store.refoldRoutes(workspaceId, { since: '2099-01-01T00:00:00.000Z' })).scanned,
    ).toBe(0);
    const recent = await store.refoldRoutes(workspaceId, { since: '2026-10-20T12:00:00.000Z' });
    expect(recent.changed.map((call) => call.callId).sort()).toEqual(['c-end', 'c-xfer']);
    await store.refoldRoutes(workspaceId, { apply: true });
    expect(await routeOf(other, 'c-hi')).not.toHaveProperty('routeMs');
    expect((await store.refoldRoutes(other)).scanned).toBe(6);
  });

  it('leaves a call with an unreadable event as it is and says which', async () => {
    const workspaceId = `ws-bad-${randomUUID()}`;
    await legacy(workspaceId);
    await pool.query(
      `INSERT INTO ovo_session_events (workspace_id, call_id, sequence, id, at, type, payload)
       SELECT workspace_id, call_id, max(sequence) + 1, 'bad-event', now(), 'route.decision', '{"surprise":1}'::jsonb
       FROM ovo_session_events WHERE workspace_id = $1 AND call_id = 'c-en' GROUP BY workspace_id, call_id`,
      [workspaceId],
    );
    const report = await store.refoldRoutes(workspaceId, { apply: true });
    expect(report.failed).toEqual([{ callId: 'c-en', reason: expect.any(String) }]);
    expect(report.applied).toBe(5);
    expect(await routeOf(workspaceId, 'c-en')).not.toHaveProperty('routeMs');
  });

  it('is idempotent on a call that already has the fields (no write, no change)', async () => {
    const workspaceId = `ws-modern-${randomUUID()}`;
    await seedRoutedCalls(store, workspaceId);
    expect((await store.refoldRoutes(workspaceId, { apply: true })).scanned).toBe(0);
  });
});
