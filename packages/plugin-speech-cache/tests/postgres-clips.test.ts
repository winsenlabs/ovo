import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  openSpeechClipDatabase,
  PostgresSpeechClipStore,
  PostgresSpeechPrerenderQueue,
  runSpeechClipMigrations,
  type SpeechClipDatabase,
} from '../src/postgres/index.ts';

const databaseUrl = process.env.OVO_TEST_POSTGRES_URL;
const integration = databaseUrl ? describe : describe.skip;
const key = (text: string) => createHash('sha256').update(text).digest('hex');

integration('PostgreSQL speech clips (TTS-8)', () => {
  let database: SpeechClipDatabase;
  let pool: pg.Pool;
  const workspace = () => `ws-${randomUUID()}`;

  beforeAll(async () => {
    database = await openSpeechClipDatabase({ connectionString: databaseUrl! });
    pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    await runSpeechClipMigrations(pool); // idempotent: a second run applies nothing
  });
  afterAll(async () => {
    await database.close();
    await pool.end();
  });

  it('stores audio by full identity key, workspace scoped, and refuses oversize clips', async () => {
    const a = workspace();
    const b = workspace();
    const clip = {
      key: key('hello'),
      codec: 'mulaw',
      sampleRate: 8000,
      audio: Uint8Array.of(1, 2, 3),
    };
    expect(await database.clips.put({ ...clip, workspaceId: a })).toBe('stored');
    expect(await database.clips.put({ ...clip, workspaceId: a })).toBe('exists');
    expect([...(await database.clips.get(a, clip.key))!]).toEqual([1, 2, 3]);
    expect(await database.clips.get(b, clip.key)).toBeUndefined();
    const small = new PostgresSpeechClipStore(pool, { maxClipBytes: 2, maxWorkspaceBytes: 4 });
    expect(await small.put({ ...clip, key: key('big'), workspaceId: b })).toBe('too-large');
    expect(
      await small.put({ ...clip, key: key('x'), workspaceId: b, audio: Uint8Array.of(1, 2) }),
    ).toBe('stored');
    expect(
      await small.put({ ...clip, key: key('y'), workspaceId: b, audio: Uint8Array.of(1, 2) }),
    ).toBe('stored');
    expect(
      await small.put({ ...clip, key: key('z'), workspaceId: b, audio: Uint8Array.of(1) }),
    ).toBe('over-budget');
    await expect(database.clips.put({ ...clip, key: 'hello', workspaceId: a })).rejects.toThrow(
      /sha256/,
    );
    const rows = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'ovo_speech_clips'",
    );
    expect(rows.rows.map((row) => row.column_name)).not.toContain('text');
  });

  it('reads many clips at once and counts a release ref by status', async () => {
    const ws = workspace();
    const keys = ['one', 'two', 'three'].map(key);
    for (const [index, clipKey] of keys.slice(0, 2).entries())
      await database.clips.put({
        workspaceId: ws,
        key: clipKey,
        codec: 'mulaw',
        sampleRate: 8000,
        audio: Uint8Array.of(index + 1),
      });
    const found = await database.clips.getMany(ws, [...keys, 'not-a-key']);
    expect([...found.keys()].sort()).toEqual(keys.slice(0, 2).sort());
    await database.clips.markRefs(ws, 'release-1', [
      { key: keys[0]!, status: 'ready' },
      { key: keys[1]!, status: 'ready' },
      { key: keys[2]!, status: 'failed', error: 'provider unavailable' },
    ]);
    await database.clips.markRefs(ws, 'release-1', [{ key: keys[2]!, status: 'ready' }]);
    expect(await database.clips.releaseCounts(ws, 'release-1')).toEqual({ ready: 3, failed: 0 });
    expect(await database.clips.releaseCounts(ws, 'release-2')).toEqual({ ready: 0, failed: 0 });
  });

  it('collects unreferenced clips after the retention window, never referenced ones', async () => {
    const ws = workspace();
    const [kept, dropped] = [key(`kept-${ws}`), key(`dropped-${ws}`)];
    for (const clipKey of [kept, dropped])
      await database.clips.put({
        workspaceId: ws,
        key: clipKey,
        codec: 'mulaw',
        sampleRate: 8000,
        audio: Uint8Array.of(9),
      });
    await database.clips.markRefs(ws, 'release-1', [{ key: kept, status: 'ready' }]);
    await pool.query(
      "UPDATE ovo_speech_clips SET last_used_at = now() - interval '40 days' WHERE workspace_id = $1",
      [ws],
    );
    await database.clips.collectGarbage(30);
    expect(await database.clips.get(ws, kept)).toBeDefined();
    expect(await database.clips.get(ws, dropped)).toBeUndefined();
  });

  it('lets one worker at a time render a key', async () => {
    const ws = workspace();
    let release!: () => void;
    const holding = database.clips.withRenderLock(
      ws,
      key('lock'),
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await database.clips.withRenderLock(ws, key('lock'), async () => 'second')).toEqual({
      locked: false,
    });
    release();
    expect(await holding).toEqual({ locked: true, value: undefined });
    expect(await database.clips.withRenderLock(ws, key('lock'), async () => 'third')).toEqual({
      locked: true,
      value: 'third',
    });
  });
});

integration('PostgreSQL speech prerender queue (TTS-9)', () => {
  const schema = `speech_queue_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let queue: PostgresSpeechPrerenderQueue;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
      max: 4,
    });
    await runSpeechClipMigrations(pool);
    queue = new PostgresSpeechPrerenderQueue(pool);
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  it('queues a publish once per release and hands it to exactly one worker', async () => {
    const queued = await queue.enqueue({
      workspaceId: 'ws',
      releaseId: 'r1',
      agentId: 'a1',
      reason: 'publish',
      total: 6,
      perCall: 1,
      inventorySha256: 'f'.repeat(64),
    });
    expect(queued).toMatchObject({ state: 'queued', total: 6, perCall: 1 });
    await queue.enqueue({
      workspaceId: 'ws',
      releaseId: 'r1',
      agentId: 'a1',
      reason: 'publish',
      total: 6,
    });
    const claimed = (
      await Promise.all([queue.claim('worker-a', 60_000), queue.claim('worker-b', 60_000)])
    ).filter(Boolean);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ releaseId: 'r1', state: 'running', attempts: 1 });
    // A re-publish while it runs does not steal the live claim.
    await queue.enqueue({
      workspaceId: 'ws',
      releaseId: 'r1',
      agentId: 'a1',
      reason: 'publish',
      total: 6,
    });
    expect((await queue.get('ws', 'r1'))?.state).toBe('running');
    // Only the claiming worker can finish it.
    const owner = claimed[0]!.workerId!;
    const other = owner === 'worker-a' ? 'worker-b' : 'worker-a';
    await queue.finish({
      workspaceId: 'ws',
      releaseId: 'r1',
      workerId: other,
      state: 'done',
      total: 6,
      perCall: 1,
    });
    expect((await queue.get('ws', 'r1'))?.state).toBe('running');
    await queue.finish({
      workspaceId: 'ws',
      releaseId: 'r1',
      workerId: owner,
      state: 'done',
      total: 6,
      perCall: 1,
      detail: 'ok',
    });
    expect(await queue.get('ws', 'r1')).toMatchObject({
      state: 'done',
      detail: 'ok',
      inventorySha256: 'f'.repeat(64),
    });
    expect(await queue.claim('worker-a', 60_000)).toBeUndefined();
  });

  it('returns an expired claim to the queue', async () => {
    await queue.enqueue({ workspaceId: 'ws', releaseId: 'r2', agentId: 'a1', reason: 'publish' });
    expect(await queue.claim('worker-a', 1)).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await queue.claim('worker-b', 60_000)).toMatchObject({
      releaseId: 'r2',
      workerId: 'worker-b',
      attempts: 2,
    });
  });

  it('lists releases routed to enabled inbound numbers and live campaigns', async () => {
    expect(await queue.routedReleases()).toEqual([]);
    await pool.query(
      `CREATE TABLE ovo_ops_inbound_routes (organization_id text, phone_number text, release_id uuid, enabled boolean)`,
    );
    await pool.query(
      `CREATE TABLE ovo_ops_campaigns (organization_id text, agent_release_id text, status text)`,
    );
    const [routed, disabled, campaign] = [randomUUID(), randomUUID(), randomUUID()];
    await pool.query(
      `INSERT INTO ovo_ops_inbound_routes VALUES ('ws', '+911', $1, true), ('ws', '+912', $2, false), ('ws', '+913', $1, true)`,
      [routed, disabled],
    );
    await pool.query(
      `INSERT INTO ovo_ops_campaigns VALUES ('ws', $1, 'running'), ('ws', 'old', 'completed')`,
      [campaign],
    );
    expect(await queue.routedReleases()).toEqual(
      [routed, campaign].sort().map((releaseId) => ({ workspaceId: 'ws', releaseId })),
    );
  });
});
