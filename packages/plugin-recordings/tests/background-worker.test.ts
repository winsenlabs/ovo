import { describe, expect, it } from 'vitest';
import {
  MemoryRecordingRepository,
  RecordingBackgroundWorker,
  RecordingExportService,
  RecordingRetentionService,
  LiveRecordingService,
  type ObjectBackend,
} from '../src/index.ts';
import { harness } from './production-fixtures.ts';

describe('recording background worker', () => {
  it('runs bounded non-overlapping export and retention ticks with safe errors', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    let concurrent = 0;
    let maximum = 0;
    let fail = false;
    const errors: unknown[] = [];
    const worker = new RecordingBackgroundWorker(
      {
        async work(input) {
          expect(input.limit).toBe(4);
          expect(input.leaseMs).toBe(60_000);
          if (fail) {
            const error = new Error('/private/operator/path?token=secret');
            error.name = 'secret-bearing-custom-type';
            throw error;
          }
          concurrent += 1;
          maximum = Math.max(maximum, concurrent);
          entered();
          await gate;
          concurrent -= 1;
          return { claimed: 0, succeeded: 0, failed: 0 };
        },
      },
      {
        async sweep(input = {}) {
          expect(input.limit).toBe(20);
          return { examined: 0, tombstoned: 0, cleaned: 0, failed: 0 };
        },
      },
      { onError: (event) => errors.push(event) },
    );
    const first = worker.runOnce();
    await started;
    await expect(worker.runOnce()).resolves.toEqual({ ran: false });
    release();
    await expect(first).resolves.toMatchObject({ ran: true, swept: 0, cleaned: 0 });
    expect(maximum).toBe(1);
    expect(errors).toEqual([]);
    fail = true;
    await worker.runOnce();
    expect(errors).toEqual([{ operation: 'exports', errorType: 'Error' }]);
    expect(JSON.stringify(errors)).not.toContain('secret');
  });

  it('does not publish after an aborted loader and reclaims only after lease expiry', async () => {
    const run = await harness();
    const recording = await run.service.create({
      workspaceId: 'workspace',
      callId: 'call-export-timeout',
      retentionDays: 1,
      segmentBytes: 64 * 1024,
    });
    await run.service.state(recording.id, 'available');
    let release!: () => void;
    let entered!: () => void;
    const firstInput = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    let loads = 0;
    const service = new RecordingExportService(
      run.repository,
      run.objects,
      async () => {
        loads += 1;
        if (loads === 1) {
          entered();
          await firstInput;
        }
        return { transcript: [], events: [] };
      },
      () => run.clock.value,
    );
    const job = await service.request({
      workspaceId: recording.workspaceId,
      artifactId: recording.id,
      idempotencyKey: 'abort-and-reclaim',
    });
    const controller = new AbortController();
    const work = service.work({ owner: 'worker-a', leaseMs: 60_000, signal: controller.signal });
    await started;
    controller.abort(new Error('bounded worker timeout'));
    await expect(work).rejects.toThrow('bounded worker timeout');
    let drained = false;
    const draining = service.drain().then(() => (drained = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    release();
    await draining;
    expect((await service.status(recording.workspaceId, job.id))?.state).toBe('running');
    expect(
      await run.objects.list(`exports/${recording.workspaceId}/${recording.id}/${job.id}/`),
    ).toEqual([]);
    run.clock.value += 60_001;
    await expect(service.work({ owner: 'worker-b', leaseMs: 60_000 })).resolves.toEqual({
      claimed: 1,
      succeeded: 1,
      failed: 0,
    });
    expect((await service.status(recording.workspaceId, job.id))?.leaseEpoch).toBe(2);
  });

  it('waits for an active upload before shutdown and cleans an aborted output', async () => {
    const repository = new MemoryRecordingRepository();
    const objects = new GatedObjectBackend();
    const live = new LiveRecordingService(repository, objects);
    const recording = await live.create({
      workspaceId: 'workspace',
      callId: 'call-shutdown',
      retentionDays: 1,
      segmentBytes: 64 * 1024,
    });
    await live.state(recording.id, 'available');
    const exports = new RecordingExportService(repository, objects, async () => ({
      transcript: [],
      events: [],
    }));
    const job = await exports.request({
      workspaceId: recording.workspaceId,
      artifactId: recording.id,
      idempotencyKey: 'shutdown-upload',
    });
    const worker = new RecordingBackgroundWorker(
      exports,
      new RecordingRetentionService(repository, objects),
    );
    worker.start();
    await objects.started;
    let stopped = false;
    const stopping = worker.stop().then(() => (stopped = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    objects.release();
    await stopping;
    expect(objects.keys()).toEqual([]);
    expect((await repository.getExport(recording.workspaceId, job.id))?.state).toBe('running');
  });

  it('persists only classified export failures', async () => {
    const run = await harness();
    const recording = await run.service.create({
      workspaceId: 'workspace',
      callId: 'call-safe-error',
      retentionDays: 1,
      segmentBytes: 64 * 1024,
    });
    await run.service.state(recording.id, 'available');
    const service = new RecordingExportService(run.repository, run.objects, async () => {
      const error = new Error('postgresql://operator:secret@private-host/recordings');
      error.name = 'postgresql://operator:secret@private-host/recordings';
      throw error;
    });
    const job = await service.request({
      workspaceId: recording.workspaceId,
      artifactId: recording.id,
      idempotencyKey: 'safe-error',
    });
    await expect(service.work({ owner: 'worker' })).resolves.toEqual({
      claimed: 1,
      succeeded: 0,
      failed: 1,
    });
    const failed = await service.status(recording.workspaceId, job.id);
    expect(failed).toMatchObject({ state: 'failed', error: 'Recording export failed (Error)' });
    expect(JSON.stringify(failed)).not.toContain('secret');
  });
});

class GatedObjectBackend implements ObjectBackend {
  private readonly data = new Map<string, Uint8Array>();
  private open!: () => void;
  private entered!: () => void;
  readonly started = new Promise<void>((resolve) => (this.entered = resolve));
  private readonly gate = new Promise<void>((resolve) => (this.open = resolve));
  async put(key: string, data: Uint8Array) {
    this.entered();
    await this.gate;
    this.data.set(key, Uint8Array.from(data));
  }
  async get(key: string) {
    return Uint8Array.from(this.data.get(key)!);
  }
  async delete(key: string) {
    this.data.delete(key);
  }
  async list(prefix: string) {
    return [...this.data.keys()].filter((key) => key.startsWith(prefix));
  }
  close() {}
  release() {
    this.open();
  }
  keys() {
    return [...this.data.keys()];
  }
}
