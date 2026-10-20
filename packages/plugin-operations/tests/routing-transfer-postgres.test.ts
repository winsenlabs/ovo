import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RoutingPointDraft, type RoutingMemberCandidate } from '@winsendotai/ovo-contracts';
import m001 from '../migrations/001_operations.sql?raw';
import m002 from '../migrations/002_live_launch.sql?raw';
import m003 from '../migrations/003_inbound_gateway.sql?raw';
import m004 from '../migrations/004_inbound_overflow.sql?raw';
import m005 from '../migrations/005_inbound_carrier.sql?raw';
import m006 from '../migrations/006_inbound_admission_carrier.sql?raw';
import m007 from '../migrations/007_campaign_pacing.sql?raw';
import m008 from '../migrations/008_outbound_compliance.sql?raw';
import m009 from '../migrations/009_india_compliance.sql?raw';
import m010 from '../migrations/010_routing.sql?raw';
import m011 from '../migrations/011_routing_transfer.sql?raw';
import m012 from '../migrations/012_inbound_default_variables.sql?raw';
import { PostgresOperationsService, runOperationsMigrations } from '../src/index.ts';
import { releaseIds, routingSchema, salesDraft, salesPool } from './routing-fixture.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
const organizationId = 'org-routing-transfer';

/** One second of 8 kHz mu-law silence-ish bytes, `seed` making each clip distinct. */
function clip(seed: number, ms = 1_000) {
  const audio = new Uint8Array(ms * 8).fill(0xff);
  audio[0] = seed;
  return {
    audio,
    durationMs: ms,
    sha256: createHash('sha256').update(audio).digest('hex'),
    source: { container: 'wav', encoding: 'pcm_s16le', sampleRate: 16_000, channels: 1 } as const,
    createdBy: 'user:tester',
  };
}

/** The sales draft plus a transfer catalogue naming `poolId` and holding with `audioId`. */
function transferDraft(salesPoolId: string, poolId: string, audioId: string) {
  return RoutingPointDraft.parse({
    ...salesDraft(salesPoolId, `Transfers ${randomUUID()}`),
    transfer: {
      hold: {
        steps: [{ kind: 'clip', assetId: audioId }],
        onTimeout: [{ kind: 'default' }],
      },
      targets: [
        {
          key: 'billing',
          description: 'Payments',
          destination: { kind: 'pool', poolId },
        },
      ],
    },
  });
}

describe.skipIf(!postgresUrl)('operations migration 011 and routing transfer storage', () => {
  let db: Awaited<ReturnType<typeof routingSchema>>;
  let operations: PostgresOperationsService;

  beforeAll(async () => {
    db = await routingSchema(postgresUrl!);
    // A database exactly as Wave 15 left it: 001-010 applied.
    await db.pool.query(
      'CREATE TABLE ovo_ops_schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const sql = [m001, m002, m003, m004, m005, m006, m007, m008, m009, m010];
    for (const [index, statement] of sql.entries()) {
      await db.pool.query(statement);
      await db.pool.query('INSERT INTO ovo_ops_schema_migrations (version) VALUES ($1)', [
        index + 1,
      ]);
    }
    operations = new PostgresOperationsService({ pool: db.pool, organizationId });
  });

  afterAll(async () => db?.drop());

  it('applies 011 and 012 over an R1 database and reruns as a no-op', async () => {
    await runOperationsMigrations(db.pool);
    await runOperationsMigrations(db.pool);
    await db.pool.query(m011);
    await db.pool.query(m012);
    await expect(
      db.pool.query(
        `INSERT INTO ovo_ops_inbound_routes (organization_id, phone_number, release_id,
           default_variables_schema) VALUES ($1, '+14155550199', $2, '[]'::jsonb)`,
        [organizationId, randomUUID()],
      ),
    ).rejects.toThrow(/default_variables_schema/);
    const versions = await db.pool.query<{ version: number }>(
      'SELECT version FROM ovo_ops_schema_migrations ORDER BY version',
    );
    expect(versions.rows.map((row) => row.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);
  });

  it('creates, lists and reads clips; names are unique among live clips', async () => {
    const audio = operations.routing.audio;
    const music = await audio.create({ name: 'Hold music', ...clip(1) });
    if (music === 'name_taken') throw new Error('unexpected');
    expect(music).toMatchObject({
      workspaceId: organizationId,
      name: 'Hold music',
      codec: 'audio/x-mulaw',
      sampleRate: 8000,
      durationMs: 1_000,
      byteLength: 8_000,
      createdBy: 'user:tester',
      source: { container: 'wav', encoding: 'pcm_s16le', sampleRate: 16_000, channels: 1 },
    });
    expect(music.deletedAt).toBeUndefined();
    expect(await audio.create({ name: 'HOLD MUSIC', ...clip(2) })).toBe('name_taken');
    expect(await audio.get(music.id)).toEqual(music);
    expect((await audio.list(50)).map((found) => found.id)).toContain(music.id);
    expect(await audio.list(50, music.id)).not.toContainEqual(music);
    expect(await audio.get('not-a-uuid')).toBeUndefined();
    expect(await audio.content(music.id, music.sha256)).toEqual(clip(1).audio);
    expect(await audio.content(music.id, 'f'.repeat(64))).toBeUndefined();
  });

  it('refuses a digest that does not match and clips out of bounds', async () => {
    const audio = operations.routing.audio;
    await expect(audio.create({ name: 'Bad', ...clip(3), sha256: 'a'.repeat(64) })).rejects.toThrow(
      /sha256/,
    );
    for (const ms of [50, 300_001])
      await expect(audio.create({ name: `Odd ${ms}`, ...clip(4, ms) })).rejects.toThrow(/0.1-300/);
    await expect(audio.create({ name: ' ', ...clip(5) })).rejects.toThrow();
  });

  it('keeps clip bytes immutable and only soft-deletes', async () => {
    const created = await operations.routing.audio.create({ name: 'Immutable', ...clip(6) });
    if (created === 'name_taken') throw new Error('unexpected');
    const update = (set: string) =>
      db.pool.query(`UPDATE ovo_routing_audio SET ${set} WHERE id = $1`, [created.id]);
    await expect(update(`audio = '\\x00'::bytea, byte_length = 1`)).rejects.toThrow();
    await expect(update(`sha256 = '${'b'.repeat(64)}'`)).rejects.toThrow(/immutable/);
    await expect(
      db.pool.query('DELETE FROM ovo_routing_audio WHERE id = $1', [created.id]),
    ).rejects.toThrow(/immutable/);
    await expect(update(`name = 'Renamed'`)).resolves.toMatchObject({ rowCount: 1 });
    expect(await operations.routing.audio.remove(created.id)).toBe('removed');
    expect(await operations.routing.audio.remove(created.id)).toBe('missing');
    expect(await operations.routing.audio.get(created.id)).toBeUndefined();
    expect(await operations.routing.audio.get(created.id, { includeDeleted: true })).toMatchObject({
      id: created.id,
      deletedAt: expect.any(String),
    });
    // A pinned release keeps playing a deleted clip by its digest; its name is free again.
    expect(await operations.routing.audio.content(created.id, created.sha256)).toEqual(
      clip(6).audio,
    );
    expect(await operations.routing.audio.create({ name: 'Renamed', ...clip(7) })).not.toBe(
      'name_taken',
    );
  });

  it('links transfer pools and hold clips to the drafts that name them', async () => {
    const { routing } = operations;
    const sales = await routing.pools.create(salesPool(releaseIds(), `Sales ${randomUUID()}`));
    const billing = await routing.pools.create(salesPool(releaseIds(), `Billing ${randomUUID()}`));
    const music = await routing.audio.create({ name: `Music ${randomUUID()}`, ...clip(8) });
    if (music === 'name_taken') throw new Error('unexpected');
    const point = await routing.points.create(transferDraft(sales.id, billing.id, music.id));
    expect(await routing.pools.usedBy(sales.id)).toEqual([point.id]);
    expect(await routing.pools.usedBy(billing.id)).toEqual([point.id]);
    expect(await routing.audio.usedBy(music.id)).toEqual([point.id]);
    expect(await routing.audio.remove(music.id)).toEqual({ inUseBy: [point.id] });
    expect(await routing.pools.remove(billing.id, billing.version)).toEqual({
      inUseBy: [point.id],
    });
    // The draft drops its transfer catalogue: neither is named any more.
    const updated = await routing.points.update(
      point.id,
      salesDraft(sales.id, point.draft.name),
      point.draftVersion,
    );
    expect(updated?.draftVersion).toBe(2);
    expect(await routing.pools.usedBy(billing.id)).toEqual([]);
    expect(await routing.audio.usedBy(music.id)).toEqual([]);
    expect(await routing.audio.remove(music.id)).toBe('removed');
    expect(await routing.pools.remove(billing.id, billing.version)).toBe('removed');
    // A deleted point names nothing.
    const other = await routing.points.create(salesDraft(sales.id, `Other ${randomUUID()}`));
    expect(await routing.pools.usedBy(sales.id)).toEqual([point.id, other.id].sort());
    expect(await routing.points.remove(other.id, other.draftVersion)).toBe('removed');
    expect(await routing.pools.usedBy(sales.id)).toEqual([point.id]);
    expect(await routing.pools.usedBy('nope')).toEqual([]);
  });

  it('reads a deleted pool only with includeDeleted, with deletedAt', async () => {
    const { routing } = operations;
    const pool = await routing.pools.create(salesPool(releaseIds(), `Gone ${randomUUID()}`));
    expect((await routing.pools.get(pool.id))?.deletedAt).toBeUndefined();
    expect(await routing.pools.remove(pool.id, pool.version)).toBe('removed');
    expect(await routing.pools.get(pool.id)).toBeUndefined();
    expect(await routing.pools.get(pool.id, { includeDeleted: true })).toMatchObject({
      id: pool.id,
      version: pool.version,
      deletedAt: expect.any(String),
    });
  });
});

describe.skipIf(!postgresUrl)('routing claims across transfers (R2 keep-on-full)', () => {
  let db: Awaited<ReturnType<typeof routingSchema>>;
  let operations: PostgresOperationsService;
  const routingReleaseId = randomUUID();
  const SOURCE = randomUUID();
  const TARGET = randomUUID();
  const ids = releaseIds();
  const member = (poolId: string, memberId: string, capacity?: number): RoutingMemberCandidate => ({
    poolId,
    memberId,
    agentId: memberId,
    releaseId: ids.en,
    ...(capacity === undefined ? {} : { capacity }),
  });
  const claim = (callId: string, tiers: RoutingMemberCandidate[][]) =>
    operations.routing.claims.claim({ callId, routingReleaseId, ttlSeconds: 300, tiers });
  const activePerCall = async () =>
    (
      await db.pool.query<{ call_id: string; active: number }>(
        `SELECT call_id, count(*)::int AS active FROM ovo_routing_member_claims
         WHERE released_at IS NULL GROUP BY call_id HAVING count(*) > 1`,
      )
    ).rows;

  beforeAll(async () => {
    db = await routingSchema(postgresUrl!);
    operations = new PostgresOperationsService({ pool: db.pool, organizationId: 'org-transfer' });
    await operations.migrate();
  });

  afterAll(async () => db?.drop());

  it('keeps the transferring member claim when the target is full', async () => {
    expect(await claim('call-a', [[member(SOURCE, 'sales-a')]])).toMatchObject({ kind: 'claimed' });
    expect(await claim('blocker', [[member(TARGET, 'bill-1', 1)]])).toMatchObject({
      kind: 'claimed',
    });
    expect(await claim('call-a', [[member(TARGET, 'bill-1', 1)]])).toEqual({ kind: 'full' });
    expect(await operations.routing.claims.active(SOURCE)).toEqual({ 'sales-a': 1 });
    // Once there is room the transfer takes the new member and gives the old one back, together.
    await operations.routing.claims.release('blocker');
    expect(await claim('call-a', [[member(TARGET, 'bill-1', 1)]])).toMatchObject({
      kind: 'claimed',
      candidate: { memberId: 'bill-1' },
    });
    expect(await operations.routing.claims.active(SOURCE)).toEqual({});
    expect(await operations.routing.claims.active(TARGET)).toEqual({ 'bill-1': 1 });
    await operations.routing.claims.release('call-a');
  });

  it('never overfills, never double-claims, and keeps refused calls on 20 parallel transfers', async () => {
    for (let i = 0; i < 20; i += 1)
      expect((await claim(`transfer-${i}`, [[member(SOURCE, `seat-${i % 4}`)]])).kind).toBe(
        'claimed',
      );
    const tier = [member(TARGET, 'agent-a', 5), member(TARGET, 'agent-b', 3)];
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => claim(`transfer-${i}`, [tier])),
    );
    const moved = results.filter((result) => result.kind === 'claimed');
    expect(moved).toHaveLength(8);
    expect(results.filter((result) => result.kind === 'full')).toHaveLength(12);
    expect(await operations.routing.claims.active(TARGET)).toEqual({ 'agent-a': 5, 'agent-b': 3 });
    const kept = Object.values(await operations.routing.claims.active(SOURCE));
    expect(kept.reduce((sum, count) => sum + count, 0)).toBe(12);
    expect(await activePerCall()).toEqual([]);
    for (let i = 0; i < 20; i += 1)
      expect(await operations.routing.claims.release(`transfer-${i}`)).toBe(1);
    expect(await operations.routing.claims.active(TARGET)).toEqual({});
    expect(await operations.routing.claims.active(SOURCE)).toEqual({});
  });
});
