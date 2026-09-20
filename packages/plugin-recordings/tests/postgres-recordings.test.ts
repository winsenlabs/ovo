import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compose } from '@winsendotai/ovo-runtime';
import {
  LiveRecordingService,
  LocalRecordingBackend,
  RecordingExportService,
  RecordingRetentionService,
  type ObjectBackend,
} from '../src/index.ts';
import { PostgresRecordingRepository } from '../src/production.ts';
import {
  createProductionRecordingsPlugin,
  RECORDING_SERVICE_KEYS,
  type ProductionRecordingServices,
} from '../src/production.ts';

const databaseUrl = process.env.RECORDING_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('PostgreSQL recording metadata', () => {
  const schema = `recording_${randomUUID().replaceAll('-', '')}`;
  let directory: string;
  let repository: PostgresRecordingRepository;
  let service: LiveRecordingService;
  let objects: LocalRecordingBackend;
  let now = Date.now();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ovo-pg-recordings-'));
    repository = new PostgresRecordingRepository({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
    });
    await repository.pool.query(`CREATE SCHEMA ${schema}`);
    await repository.migrate();
    objects = new LocalRecordingBackend(directory);
    service = new LiveRecordingService(repository, objects, () => now);
  });

  afterAll(async () => {
    await repository.pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await repository.close();
    objects.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('persists manifests, fences leased exports, and tombstones access before cleanup', async () => {
    const recording = await service.create({
      workspaceId: 'workspace',
      callId: 'call',
      retentionDays: 1,
      segmentBytes: 64 * 1024,
    });
    await service.writeSegment({
      recording,
      track: 'inbound',
      sequence: 0,
      bytes: Uint8Array.of(1, 2, 3),
      startMs: 5,
      endMs: 5.375,
    });
    await service.state(recording.id, 'available');
    const manifest = await service.manifest('workspace', 'call', recording.id);
    expect(manifest.segments[0]).toMatchObject({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });

    const exports = new RecordingExportService(
      repository,
      objects,
      async () => ({ transcript: [], events: [] }),
      () => now,
    );
    const job = await exports.request({
      workspaceId: 'workspace',
      artifactId: recording.id,
      idempotencyKey: 'pg-export',
    });
    const [first] = await repository.claimExports(
      'worker-1',
      new Date(now).toISOString(),
      1_000,
      1,
    );
    now += 1_001;
    const [second] = await repository.claimExports(
      'worker-2',
      new Date(now).toISOString(),
      1_000,
      1,
    );
    await expect(
      repository.settleExport(job.id, 'worker-1', first!.leaseEpoch, new Date(now).toISOString(), {
        state: 'failed',
        error: 'stale',
      }),
    ).rejects.toThrow('lease lost');
    expect(second!.leaseEpoch).toBe(2);
    await repository.pool.query(
      "UPDATE ovo_recording_exports SET lease_expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=$1",
      [job.id],
    );
    await expect(
      repository.settleExport(
        job.id,
        'worker-2',
        second!.leaseEpoch,
        new Date(now - 1_000).toISOString(),
        { state: 'failed', error: 'caller supplied a stale timestamp' },
      ),
    ).rejects.toThrow('lease lost');

    await service.delete('workspace', 'call', recording.id, 'operator');
    await expect(service.manifest('workspace', 'call', recording.id)).rejects.toThrow(
      'unavailable',
    );
    expect(await repository.getExport('workspace', job.id)).toBeUndefined();
    const retention = new RecordingRetentionService(repository, objects, () => now);
    expect(await retention.cleanup()).toEqual({ cleaned: 1, failed: 0 });
    expect(await repository.getTombstone(recording.id)).toMatchObject({ cleanupState: 'complete' });
  });

  it('physically sweeps expired recording objects in bounded pages', async () => {
    const recording = await service.create({
      workspaceId: 'workspace',
      callId: 'expired',
      retentionDays: 1,
      segmentBytes: 64 * 1024,
    });
    await service.writeSegment({
      recording,
      track: 'outbound',
      sequence: 0,
      bytes: Uint8Array.of(4, 5),
      startMs: 0,
      endMs: 0.25,
    });
    await service.state(recording.id, 'available');
    now += 86_400_001;
    const retention = new RecordingRetentionService(repository, objects, () => now);
    expect(await retention.sweep({ limit: 1 })).toMatchObject({
      examined: 1,
      tombstoned: 1,
      cleaned: 1,
    });
  });

  it('serializes tombstones against late segment metadata and indexes failed compensation', async () => {
    let uploaded!: () => void;
    const uploadComplete = new Promise<void>((resolve) => (uploaded = resolve));
    const faultObjects: ObjectBackend = {
      async put(key, data, contentType) {
        await objects.put(key, data, contentType);
        uploaded();
      },
      get: (key) => objects.get(key),
      delete: async () => {
        throw new Error('simulated compensating delete failure');
      },
      list: (prefix) => objects.list(prefix),
      close: () => undefined,
    };
    const raceService = new LiveRecordingService(repository, faultObjects, () => now);
    const recording = await raceService.create({
      workspaceId: 'workspace',
      callId: 'late-pg-upload',
      retentionDays: 1,
      segmentBytes: 64 * 1024,
    });
    const lock = await repository.pool.connect();
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM ovo_recording_artifacts WHERE id=$1 FOR UPDATE', [
      recording.id,
    ]);
    const writing = raceService.writeSegment({
      recording,
      track: 'inbound',
      sequence: 0,
      bytes: Uint8Array.of(1, 2, 3),
      startMs: 0,
      endMs: 0.375,
    });
    await uploadComplete;
    await lock.query(
      `INSERT INTO ovo_recording_tombstones
       (artifact_id,workspace_id,call_id,requested_at,reason,cleanup_state)
       VALUES($1,$2,$3,$4,'operator','pending')`,
      [recording.id, recording.workspaceId, recording.callId, new Date(now).toISOString()],
    );
    await lock.query('COMMIT');
    lock.release();
    await expect(writing).rejects.toThrow('unavailable');
    const [key] = await repository.objectKeysForDeletion(recording.id);
    expect(key).toBeDefined();
    const [beforeLateIndex] = await repository.pendingTombstones(1);
    await repository.recordCleanupObject(recording.id, key!);
    expect(
      await repository.recordCleanup(
        recording.id,
        new Date(now).toISOString(),
        undefined,
        beforeLateIndex!.attempts,
      ),
    ).toBe(false);
    expect(await repository.getTombstone(recording.id)).toMatchObject({ cleanupState: 'pending' });
  });

  it('composes a bounded process service and disposes its PostgreSQL pool', async () => {
    const pluginDirectory = await mkdtemp(join(tmpdir(), 'ovo-pg-recording-plugin-'));
    let blockLoader = false;
    let loaderEntered!: () => void;
    const loaderStarted = new Promise<void>((resolve) => (loaderEntered = resolve));
    let productionRepository!: PostgresRecordingRepository;
    let poolWasAvailableDuringStop = false;
    const plugin = createProductionRecordingsPlugin(
      {
        databaseUrl: databaseUrl!,
        backend: 'filesystem',
        directory: pluginDirectory,
        durableMounted: true,
        sharedAcrossWorkers: true,
      },
      {
        background: { pollIntervalMs: 250, exportLeaseMs: 2_000, exportTimeoutMs: 1_000 },
        loadExportInput: async (_recording, options) => {
          if (!blockLoader) return { transcript: [], events: [] };
          loaderEntered();
          await new Promise<void>((_resolve, reject) => {
            options!.signal!.addEventListener(
              'abort',
              () => {
                void productionRepository.pool.query('SELECT 1').then(() => {
                  poolWasAvailableDuringStop = true;
                  reject(options!.signal!.reason);
                }, reject);
              },
              { once: true },
            );
          });
          return { transcript: [], events: [] };
        },
      },
    );
    const composition = await compose([{ id: plugin.manifest.id, config: {} }], [plugin]);
    const services = composition.ctx.get(RECORDING_SERVICE_KEYS.production) as
      ProductionRecordingServices | undefined;
    expect(services).toBeDefined();
    productionRepository = services!.repository as PostgresRecordingRepository;
    expect(productionRepository.pool.options.max).toBe(2);
    const recording = await services!.live.create({
      workspaceId: 'workspace',
      callId: 'shutdown-order',
      retentionDays: 1,
      segmentBytes: 64 * 1024,
    });
    await services!.live.state(recording.id, 'available');
    blockLoader = true;
    await services!.exports.request({
      workspaceId: recording.workspaceId,
      artifactId: recording.id,
      idempotencyKey: 'shutdown-order',
    });
    void services!.worker.runOnce();
    await loaderStarted;
    await composition.dispose();
    expect(poolWasAvailableDuringStop).toBe(true);
    await expect(productionRepository.pool.query('SELECT 1')).rejects.toThrow();
    await rm(pluginDirectory, { recursive: true, force: true });
  });
});
