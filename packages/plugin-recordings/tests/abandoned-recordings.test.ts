import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ABANDONED_AFTER_MS,
  ABANDONED_FAILURE,
  LiveRecordingService,
  LocalRecordingBackend,
  RecordingRetentionService,
  type ObjectBackend,
  type RecordingRepository,
} from '../src/index.ts';
import { PostgresRecordingRepository } from '../src/production.ts';
import { captureFixture, harness } from './production-fixtures.ts';

const HOUR = 3_600_000;
const frames = (bytes: number) => new Uint8Array(bytes).fill(0x55);

/**
 * A worker that exits mid-call never calls `finish`: its artifact stayed `active` until it
 * expired, and the API refuses audio that is not finalized, so the segments it had already
 * written could never be played.
 */
async function abandonedCall(service: LiveRecordingService, clock: { value: number }) {
  const held = await service.create({
    workspaceId: 'workspace',
    callId: 'crashed',
    retentionDays: 30,
    segmentBytes: 64 * 1024,
  });
  await service.state(held.id, 'active');
  await service.writeSegment({
    recording: held,
    track: 'inbound',
    sequence: 0,
    bytes: frames(64 * 1024),
    startMs: 0,
    endMs: 8_192,
  });
  const empty = await service.create({
    workspaceId: 'workspace',
    callId: 'empty',
    retentionDays: 30,
  });
  const finished = await service.create({
    workspaceId: 'workspace',
    callId: 'done',
    retentionDays: 30,
  });
  await service.state(finished.id, 'available');
  clock.value += HOUR;
  const live = await service.create({
    workspaceId: 'workspace',
    callId: 'live',
    retentionDays: 30,
  });
  await service.state(live.id, 'active');
  return { held, empty, finished, live };
}

async function expectRecovered(
  repository: RecordingRepository,
  objects: ObjectBackend,
  clock: { value: number },
) {
  const service = new LiveRecordingService(repository, objects, () => clock.value);
  const retention = new RecordingRetentionService(repository, objects, () => clock.value);
  const started = clock.value;
  const calls = await abandonedCall(service, clock);
  // An hour in, any of them could still be on the line.
  expect(await retention.sweep()).toMatchObject({ recovered: 0 });
  clock.value = started + ABANDONED_AFTER_MS + 1;
  expect(await retention.sweep()).toMatchObject({ recovered: 2, tombstoned: 0 });
  const state = async (callId: string, id: string) =>
    (await service.manifest('workspace', callId, id)).state;
  expect(await service.manifest('workspace', 'crashed', calls.held.id)).toMatchObject({
    state: 'partial',
    failure: ABANDONED_FAILURE,
  });
  // What the worker wrote before it exited plays again.
  const segment = await service.readSegment('workspace', 'crashed', calls.held.id, 'inbound', 0);
  expect(segment.bytes.byteLength).toBe(64 * 1024);
  expect(await state('empty', calls.empty.id)).toBe('failed');
  expect(await state('done', calls.finished.id)).toBe('available');
  // Created an hour later, the last call is not yet past the bound.
  expect(await state('live', calls.live.id)).toBe('active');
  expect(await retention.sweep()).toMatchObject({ recovered: 0 });
}

describe('recordings a crashed worker left unfinalized', () => {
  it('become playable partial artifacts once no call could still be running', async () => {
    const run = await harness();
    await expectRecovered(run.repository, run.objects, run.clock);
  });

  it('report what a finished capture durably holds per track', async () => {
    const run = await captureFixture();
    run.media.receive(frames(70_000), 0);
    await run.capture.sendAudio(frames(8_000));
    await run.capture.finish();
    expect(run.capture.outcome).toEqual({
      state: 'available',
      bytes: { inbound: 70_000, outbound: 8_000 },
    });
  });

  it('report a capture that lost audio as partial', async () => {
    const run = await captureFixture({ failPutAt: 1 });
    run.media.receive(frames(70_000), 0);
    await run.capture.finish();
    expect(run.capture.outcome.state).toBe('partial');
  });
});

const databaseUrl = process.env.RECORDING_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('PostgreSQL recovery of abandoned recordings', () => {
  it('settles them in one bounded statement with the same rules', async () => {
    const schema = `recording_${randomUUID().replaceAll('-', '')}`;
    const directory = await mkdtemp(join(tmpdir(), 'ovo-pg-abandoned-'));
    const repository = new PostgresRecordingRepository({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
    });
    const objects = new LocalRecordingBackend(directory);
    try {
      await repository.pool.query(`CREATE SCHEMA ${schema}`);
      await repository.migrate();
      await expectRecovered(repository, objects, { value: Date.parse('2026-10-07T13:00:00Z') });
    } finally {
      await repository.pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await repository.close();
      objects.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
