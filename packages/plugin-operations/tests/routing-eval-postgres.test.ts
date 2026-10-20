import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresOperationsService, runOperationsMigrations } from '../src/index.ts';
import { cases, scorecard } from './routing-eval-fixture.ts';
import { publishedRelease, releaseIds, routingSchema } from './routing-fixture.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!postgresUrl)('operations migration 014 and routing eval runs', () => {
  let db: Awaited<ReturnType<typeof routingSchema>>;
  let operations: PostgresOperationsService;
  let other: PostgresOperationsService;
  let release: Awaited<ReturnType<typeof publishedRelease>>;
  const digest = 'c'.repeat(64);
  const input = (extra: Record<string, unknown> = {}) => ({
    routingReleaseId: release.id,
    name: 'Nightly',
    corpusDigest: digest,
    scorecard: scorecard(),
    corpus: cases(),
    createdBy: 'user:tester',
    ...extra,
  });

  beforeAll(async () => {
    db = await routingSchema(postgresUrl!);
    operations = new PostgresOperationsService({ pool: db.pool, organizationId: 'org-eval' });
    other = new PostgresOperationsService({ pool: db.pool, organizationId: 'org-eval-other' });
    await operations.migrate();
    release = await publishedRelease(operations.routing, releaseIds());
  });

  afterAll(async () => db?.drop());

  it('is migration 14, creates the table and index, and reruns as a no-op', async () => {
    await runOperationsMigrations(db.pool);
    const versions = await db.pool.query<{ version: number }>(
      'SELECT max(version)::int AS version FROM ovo_ops_schema_migrations',
    );
    expect(versions.rows[0]!.version).toBe(14);
    const indexes = await db.pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'ovo_routing_eval_runs'`,
      [db.schema],
    );
    expect(indexes.rows.map((row) => row.indexname)).toContain('ovo_routing_eval_runs_recent_idx');
  });

  it('creates a run against a release and reads it back whole', async () => {
    const run = await operations.routing.evalRuns.create(input());
    expect(run).toMatchObject({
      name: 'Nightly',
      routingReleaseId: release.id,
      routingPointId: release.routingPointId,
      releaseVersion: release.version,
      createdBy: 'user:tester',
      engineMode: 'recorded',
      caseCount: 2,
      corpusDigest: digest,
      headline: { passed: 1, total: 2, accuracy: 0.5, fallbackRate: 0, clarifyRate: 0.5 },
    });
    expect(run!.scorecard).toEqual(scorecard());
    expect(await operations.routing.evalRuns.get(run!.id)).toEqual(run);
    expect(await operations.routing.evalRuns.corpus(run!.id)).toEqual(cases());
  });

  it('reads an empty rate as null in the headline', async () => {
    const empty = scorecard(2, 0);
    empty.accuracy.overall = { correct: 0, total: 0, rate: null };
    const run = await operations.routing.evalRuns.create(input({ scorecard: empty }));
    expect(run!.headline).toMatchObject({ passed: 0, total: 2, accuracy: null });
  });

  it('refuses an unknown release, another organization release, and a bad scorecard or corpus', async () => {
    expect(
      await operations.routing.evalRuns.create(input({ routingReleaseId: randomUUID() })),
    ).toBeUndefined();
    expect(
      await operations.routing.evalRuns.create(input({ routingReleaseId: 'nope' })),
    ).toBeUndefined();
    expect(await other.routing.evalRuns.create(input())).toBeUndefined();
    await expect(operations.routing.evalRuns.create(input({ corpus: [] }))).rejects.toThrow(
      /at least one/,
    );
    await expect(
      operations.routing.evalRuns.create(input({ scorecard: { schema: 'x' } })),
    ).rejects.toThrow();
    await expect(
      operations.routing.evalRuns.create(input({ corpusDigest: 'short' })),
    ).rejects.toThrow(/corpus_digest|check/i);
    await expect(operations.routing.evalRuns.create(input({ name: '' }))).rejects.toThrow(
      /name|check/i,
    );
    await expect(operations.routing.evalRuns.create(input({ createdBy: ' ' }))).rejects.toThrow(
      /createdBy/,
    );
  });

  it('holds the foreign key to the release at the database', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO ovo_routing_eval_runs (organization_id, id, routing_release_id, routing_point_id,
           release_version, name, engine_mode, corpus_digest, case_count, scorecard, corpus, created_by)
         VALUES ('org-eval', $1, $2, $3, 1, 'x', 'recorded', $4, 1, '{}', '[]', 'u')`,
        [randomUUID(), randomUUID(), randomUUID(), digest],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('lists newest first with a cursor, scoped to the organization', async () => {
    const fresh = new PostgresOperationsService({ pool: db.pool, organizationId: 'org-eval-list' });
    const owned = await publishedRelease(fresh.routing, releaseIds());
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1)
      made.push(
        (await fresh.routing.evalRuns.create(
          input({ routingReleaseId: owned.id, name: `Run ${i}` }),
        ))!.id,
      );
    const first = await fresh.routing.evalRuns.list(2);
    expect(first.map((run) => run.name)).toEqual(['Run 4', 'Run 3']);
    const second = await fresh.routing.evalRuns.list(2, first.at(-1)!.id);
    expect(second.map((run) => run.name)).toEqual(['Run 2', 'Run 1']);
    const last = await fresh.routing.evalRuns.list(2, second.at(-1)!.id);
    expect(last.map((run) => run.name)).toEqual(['Run 0']);
    expect(await fresh.routing.evalRuns.list(2, 'not-a-uuid')).toHaveLength(2);
    expect(first[0]).not.toHaveProperty('scorecard');
    expect(await other.routing.evalRuns.list(10)).toEqual([]);
    expect(await other.routing.evalRuns.get(made[0]!)).toBeUndefined();
    expect(await other.routing.evalRuns.corpus(made[0]!)).toBeUndefined();
    expect(await other.routing.evalRuns.softDelete(made[0]!)).toBe(false);
  });

  it('soft deletes a run once and keeps the row', async () => {
    const run = (await operations.routing.evalRuns.create(input({ name: 'To delete' })))!;
    expect(await operations.routing.evalRuns.softDelete(run.id)).toBe(true);
    expect(await operations.routing.evalRuns.softDelete(run.id)).toBe(false);
    expect(await operations.routing.evalRuns.get(run.id)).toBeUndefined();
    expect(await operations.routing.evalRuns.corpus(run.id)).toBeUndefined();
    expect((await operations.routing.evalRuns.list(100)).map((found) => found.id)).not.toContain(
      run.id,
    );
    const kept = await db.pool.query('SELECT deleted_at FROM ovo_routing_eval_runs WHERE id = $1', [
      run.id,
    ]);
    expect(kept.rows[0]!.deleted_at).toBeInstanceOf(Date);
    expect(await operations.routing.evalRuns.softDelete('nope')).toBe(false);
  });
});
