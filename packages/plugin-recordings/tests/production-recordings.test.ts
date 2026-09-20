import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PRODUCTION_RECORDINGS_CONFIG_SCHEMA,
  RecordingExportService,
  RecordingRetentionService,
  S3RecordingBackend,
  createSafeReplayBindings,
} from '../src/index.ts';
import { validateProductionObjectConfig } from '../src/production.ts';
import { captureFixture, harness } from './production-fixtures.ts';

describe('production live recording capture', () => {
  it('strictly validates root production storage configuration', () => {
    expect(
      PRODUCTION_RECORDINGS_CONFIG_SCHEMA.parse({
        databaseUrl: 'postgresql://recordings@postgres.internal/ovo',
        backend: 's3',
        bucket: 'recordings',
        endpoint: 'https://minio.internal',
        forcePathStyle: true,
      }),
    ).toMatchObject({ backend: 's3', bucket: 'recordings' });
    expect(() =>
      PRODUCTION_RECORDINGS_CONFIG_SCHEMA.parse({
        databaseUrl: 'postgresql://recordings@postgres.internal/ovo',
        backend: 'filesystem',
        directory: '/mnt/recordings',
        durableMounted: true,
        sharedAcrossWorkers: false,
      }),
    ).toThrow('shared across workers');
    expect(() =>
      PRODUCTION_RECORDINGS_CONFIG_SCHEMA.parse({
        databaseUrl: 'postgresql://recordings@postgres.internal/ovo',
        backend: 's3',
        bucket: 'recordings',
        apiKey: 'forbidden',
      }),
    ).toThrow();
    expect(() =>
      PRODUCTION_RECORDINGS_CONFIG_SCHEMA.parse({
        databaseUrl: 'postgresql://recordings@postgres.internal/ovo',
        backend: 's3',
        bucket: 'recordings',
        endpoint: 'https://minio.internal/user-controlled-path',
      }),
    ).toThrow('without credentials, path, query, or fragment');
  });

  it('requires explicit durable shared filesystem capability and validates fixed MinIO endpoints', () => {
    expect(() =>
      validateProductionObjectConfig({
        kind: 'filesystem',
        directory: '/mnt/recordings',
        durableMounted: false,
        sharedMultiWorker: true,
      } as never),
    ).toThrow('durable and shared');
    expect(
      () => new S3RecordingBackend('bucket', { endpoint: 'https://minio.internal/path' }),
    ).toThrow('must not include');
    const minio = new S3RecordingBackend('bucket', {
      endpoint: 'http://minio.internal',
      tls: false,
      forcePathStyle: true,
    });
    minio.close();
  });

  it('captures segmented inbound/outbound media and honest mark-confirmed alignment', async () => {
    const run = await captureFixture({ lateEvidence: true });
    const inbound = Uint8Array.from({ length: 70_000 }, (_, index) => index % 255);
    run.media.receive(inbound, 250);
    run.advance(50);
    await run.capture.sendAudio(Uint8Array.of(7, 8, 9));
    await run.capture.sendMark('speech-1:1');
    run.media.confirm('speech-1:1');
    run.evidence.emit({
      segmentId: 'speech-1',
      phase: 'acknowledged',
      at: run.clock.value + 55,
      evidence: 'confirmed',
    });
    await run.capture.finish();

    const manifest = await run.service.manifest('workspace', 'call', run.capture.artifact.id);
    expect(manifest.state).toBe('available');
    expect(manifest.segments.filter((item) => item.track === 'inbound')).toHaveLength(2);
    expect(manifest.segments.every((item) => item.bytes <= 64 * 1024)).toBe(true);
    expect(manifest.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'playback-sent', evidence: 'worker-send-resolved' }),
        expect.objectContaining({
          type: 'playback-mark-confirmed',
          evidence: 'carrier-mark-confirmed-not-human-heard',
        }),
        expect.objectContaining({ type: 'speech-evidence', evidence: 'scheduler-confirmed' }),
      ]),
    );
    const first = await run.service.readSegment(
      'workspace',
      'call',
      run.capture.artifact.id,
      'inbound',
      0,
    );
    expect(first.bytes.byteLength).toBe(64 * 1024);
  });

  it('keeps finalized chunks and reports partial when a later upload fails', async () => {
    const run = await captureFixture({ failPutAt: 2 });
    run.media.receive(new Uint8Array(130_000), 0);
    await run.capture.finish();
    const manifest = await run.service.manifest('workspace', 'call', run.capture.artifact.id);
    expect(manifest.state).toBe('partial');
    expect(manifest.failure).toContain('upload failure');
    expect(manifest.segments).toHaveLength(2);
    expect(manifest.segments[1]).toMatchObject({ state: 'failed' });
    expect(manifest.segments[1]!.objectKey).toBeUndefined();
  });
});

describe('retention tombstones and physical cleanup', () => {
  it('denies reads immediately while failed object deletion remains retryable', async () => {
    const run = await captureFixture();
    run.media.receive(new Uint8Array(100), 0);
    await run.capture.finish();
    await run.service.delete('workspace', 'call', run.capture.artifact.id, 'operator');
    run.objects.failDelete = true;
    const retention = new RecordingRetentionService(
      run.repository,
      run.objects,
      () => run.clock.value,
    );
    expect(await retention.cleanup()).toEqual({ cleaned: 0, failed: 1 });
    await expect(
      run.service.manifest('workspace', 'call', run.capture.artifact.id),
    ).rejects.toThrow('unavailable');
    const tombstone = await run.repository.getTombstone(run.capture.artifact.id);
    expect(tombstone).toMatchObject({ cleanupState: 'failed', attempts: 1 });
  });

  it('indexes a late upload for cleanup when tombstoning wins and deletion fails', async () => {
    const run = await harness();
    const recording = await run.service.create({
      workspaceId: 'workspace',
      callId: 'late-upload',
      retentionDays: 1,
      segmentBytes: 64 * 1024,
    });
    await run.service.delete('workspace', 'late-upload', recording.id, 'operator');
    run.objects.failDelete = true;
    await expect(
      run.service.writeSegment({
        recording,
        track: 'inbound',
        sequence: 0,
        bytes: Uint8Array.of(1, 2, 3),
        startMs: 0,
        endMs: 0.375,
      }),
    ).rejects.toThrow('unavailable');
    expect(await run.repository.objectKeysForDeletion(recording.id)).toHaveLength(1);
    const retention = new RecordingRetentionService(
      run.repository,
      run.objects,
      () => run.clock.value,
    );
    expect(await retention.cleanup()).toEqual({ cleaned: 0, failed: 1 });
    run.objects.failDelete = false;
    expect(await retention.cleanup()).toEqual({ cleaned: 1, failed: 0 });
  });

  it('uses a bounded cursor sweep and physically removes expired segment objects', async () => {
    const clock = { value: 1_700_000_000_000 };
    const run = await captureFixture({ clock });
    run.media.receive(new Uint8Array(100), 0);
    await run.capture.finish();
    const manifest = await run.service.manifest('workspace', 'call', run.capture.artifact.id);
    const objectKey = manifest.segments[0]!.objectKey!;
    clock.value += 86_400_001;
    const retention = new RecordingRetentionService(run.repository, run.objects, () => clock.value);
    expect(await retention.sweep({ limit: 1 })).toMatchObject({
      examined: 1,
      tombstoned: 1,
      cleaned: 1,
    });
    await expect(access(join(run.directory, objectKey))).rejects.toThrow();
    await expect(
      run.service.manifest('workspace', 'call', run.capture.artifact.id),
    ).rejects.toThrow();
  });
});

describe('redacted asynchronous exports and safe replay', () => {
  it('claims once, omits unplayed speech, redacts text, and verifies output integrity', async () => {
    const run = await captureFixture();
    run.media.receive(new Uint8Array(10), 0);
    await run.capture.finish();
    let loadedCallId: string | undefined;
    const exports = new RecordingExportService(
      run.repository,
      run.objects,
      async (recording) => {
        expect(Object.isFrozen(recording)).toBe(true);
        loadedCallId = recording.callId;
        return {
          transcript: [
            { speaker: 'customer', text: 'email alice@example.com', playback: 'confirmed' },
            { speaker: 'agent', text: 'never played secret', playback: 'unplayed' },
          ],
          events: [{ atMs: 10, type: 'tool.finished', payload: { secret: 'not exported' } }],
        };
      },
      () => run.clock.value,
    );
    const requested = await exports.request({
      workspaceId: 'workspace',
      artifactId: run.capture.artifact.id,
      idempotencyKey: 'export-1',
    });
    const duplicate = await exports.request({
      workspaceId: 'workspace',
      artifactId: run.capture.artifact.id,
      idempotencyKey: 'export-1',
    });
    expect(duplicate.id).toBe(requested.id);
    expect(
      await exports.work({ owner: 'worker-1', policy: { redactPatterns: ['[\\w.+-]+@[\\w.-]+'] } }),
    ).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    const result = await exports.read('workspace', requested.id);
    const payload = JSON.parse(Buffer.from(result.bytes).toString('utf8'));
    expect(payload.transcript).toEqual([expect.objectContaining({ text: 'email [REDACTED]' })]);
    expect(payload.events).toEqual([{ atMs: 10, type: 'tool.finished' }]);
    expect(payload.replay).toMatchObject({
      transport: 'synthetic',
      tools: 'stubbed',
      productionWrites: false,
    });
    expect(loadedCallId).toBe('call');
    await run.objects.put(result.job.outputKey!, Uint8Array.of(0), 'application/json');
    await expect(exports.read('workspace', requested.id)).rejects.toThrow('integrity');
  });

  it('fences an expired export lease after another worker reclaims it', async () => {
    const run = await captureFixture();
    await run.capture.finish();
    const exports = new RecordingExportService(
      run.repository,
      run.objects,
      async () => ({ transcript: [], events: [] }),
      () => run.clock.value,
    );
    const job = await exports.request({
      workspaceId: 'workspace',
      artifactId: run.capture.artifact.id,
      idempotencyKey: 'lease-race',
    });
    const [first] = await run.repository.claimExports(
      'worker-1',
      new Date(run.clock.value).toISOString(),
      1_000,
      1,
    );
    run.clock.value += 1_001;
    const [second] = await run.repository.claimExports(
      'worker-2',
      new Date(run.clock.value).toISOString(),
      1_000,
      1,
    );
    await expect(
      run.repository.settleExport(
        job.id,
        'worker-1',
        first!.leaseEpoch,
        new Date(run.clock.value).toISOString(),
        { state: 'failed', error: 'stale' },
      ),
    ).rejects.toThrow('lease lost');
    expect(second!.leaseEpoch).toBe(first!.leaseEpoch + 1);

    const cleanupExports = new RecordingExportService(
      run.repository,
      run.objects,
      async (recording) => {
        await run.service.delete(recording.workspaceId, recording.callId, recording.id, 'operator');
        run.objects.failDelete = true;
        return { transcript: [], events: [] };
      },
      () => run.clock.value,
    );
    await cleanupExports.request({
      workspaceId: 'workspace',
      artifactId: run.capture.artifact.id,
      idempotencyKey: 'late-export-cleanup',
    });
    expect(await cleanupExports.work({ owner: 'worker-3', policy: {} })).toEqual({
      claimed: 1,
      succeeded: 0,
      failed: 1,
    });
    expect(await run.repository.objectKeysForDeletion(run.capture.artifact.id)).toHaveLength(1);
    run.objects.failDelete = false;
    const retention = new RecordingRetentionService(
      run.repository,
      run.objects,
      () => run.clock.value,
    );
    expect(await retention.cleanup()).toEqual({ cleaned: 1, failed: 0 });
  });

  it('exposes replay bindings that cannot dial or call a live tool', async () => {
    const replay = createSafeReplayBindings();
    expect(() => replay.transport.dial()).toThrow('cannot dial');
    await expect(replay.tools.invoke({ toolId: 'mutate-customer' })).resolves.toEqual({
      ok: false,
      code: 'replay_stubbed',
      toolId: 'mutate-customer',
    });
    expect(replay.mutationPolicy).toEqual({ productionWrites: false, liveConnectors: false });
  });
});
