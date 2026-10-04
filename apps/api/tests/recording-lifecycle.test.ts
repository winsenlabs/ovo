import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LiveRecordingService,
  LocalRecordingBackend,
  MemoryRecordingRepository,
  RecordingExportService,
  RecordingRetentionService,
  type ObjectBackend,
} from '@winsendotai/ovo-plugin-recordings';
import type { Role } from '@winsendotai/ovo-plugin-storage';
import {
  createRecordingExportInputLoader,
  registerRecordingLifecycleRoutes,
} from '../src/routes/recording-lifecycle.ts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

class FaultObjects implements ObjectBackend {
  failDelete = false;
  constructor(private readonly inner: ObjectBackend) {}
  put(key: string, data: Uint8Array, contentType: string) {
    return this.inner.put(key, data, contentType);
  }
  get(key: string) {
    return this.inner.get(key);
  }
  async delete(key: string) {
    if (this.failDelete) throw new Error('simulated object deletion failure');
    await this.inner.delete(key);
  }
  list(prefix: string) {
    return this.inner.list(prefix);
  }
  close() {
    this.inner.close();
  }
}

async function setup(configured = true) {
  const app = Fastify({ logger: false });
  const workspaceId = 'workspace-a';
  const callId = randomUUID();
  const createdAt = '2026-09-20T15:00:00.000Z';
  const audits: Array<Record<string, unknown>> = [];
  const store = {
    async getCall(workspace: string, id: string) {
      return workspace === workspaceId && id === callId
        ? {
            id: callId,
            workspaceId,
            releaseId: randomUUID(),
            kind: 'live' as const,
            status: 'completed',
            createdAt,
            completedAt: '2026-09-20T15:05:00.000Z',
          }
        : undefined;
    },
    async listCallEvents(_workspace: string, _call: string, _limit: number, _cursor?: string) {
      return {
        items: [
          {
            id: randomUUID(),
            callId,
            sequence: 1,
            at: '2026-09-20T15:00:01.500Z',
            type: 'transcript.final',
            epoch: 1,
            payload: { speaker: 'customer', text: 'my email is alice@example.com' },
          },
          {
            id: randomUUID(),
            callId,
            sequence: 2,
            at: '2026-09-20T15:00:02.000Z',
            type: 'speech.generated',
            epoch: 1,
            payload: { speaker: 'agent', text: 'private unplayed response', segmentId: 'speech-1' },
          },
        ],
      };
    },
    async audit(input: Record<string, unknown>) {
      audits.push(input);
      return { ...input, id: randomUUID(), createdAt };
    },
  };
  const roles: Role[] = ['viewer', 'editor', 'admin'];
  const requireRole = (request: FastifyRequest, required: Role) => {
    const role = String(request.headers['x-role'] ?? 'admin') as Role;
    if (roles.indexOf(role) < roles.indexOf(required))
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    return {
      identityId: `actor-${role}`,
      workspaceId: String(request.headers['x-workspace'] ?? workspaceId),
      role,
    };
  };
  const error = (reply: any, status: number, code: string, message: string) =>
    reply.code(status).send({ error: { code, message } });
  const directory = await mkdtemp(join(tmpdir(), 'ovo-recording-api-'));
  directories.push(directory);
  const objects = new FaultObjects(new LocalRecordingBackend(directory));
  const repository = new MemoryRecordingRepository();
  let now = Date.parse(createdAt);
  const live = new LiveRecordingService(repository, objects, () => now);
  const retention = new RecordingRetentionService(repository, objects, () => now);
  const exports = new RecordingExportService(
    repository,
    objects,
    createRecordingExportInputLoader(store as never),
    () => now,
  );
  registerRecordingLifecycleRoutes({
    app,
    store: store as never,
    recordings: configured ? { live, retention, exports } : undefined,
    requireRole,
    error,
  });
  app.setErrorHandler((cause, _request, reply) => {
    const status =
      (cause as { name?: string }).name === 'ZodError'
        ? 400
        : ((cause as { statusCode?: number }).statusCode ?? 500);
    reply
      .code(status)
      .send({ error: { code: status === 400 ? 'invalid_request' : 'request_failed' } });
  });
  await app.ready();
  return {
    app,
    workspaceId,
    callId,
    audits,
    objects,
    repository,
    live,
    retention,
    exports,
    setNow(value: number) {
      now = value;
    },
  };
}

async function liveArtifact(
  run: Awaited<ReturnType<typeof setup>>,
  bytes = Uint8Array.of(1, 2, 3, 4),
) {
  const artifact = await run.live.create({
    workspaceId: run.workspaceId,
    callId: run.callId,
    retentionDays: 1,
    segmentBytes: 64 * 1024,
  });
  await run.live.writeSegment({
    recording: artifact,
    track: 'inbound',
    sequence: 0,
    bytes,
    startMs: 1_000,
    endMs: 1_000.5,
  });
  await run.live.state(artifact.id, 'available');
  return artifact;
}

describe('recording lifecycle API', () => {
  it('rejects an oversized durable event page before export materialization', async () => {
    const loader = createRecordingExportInputLoader({
      async listCallEvents() {
        return { items: Array.from({ length: 101 }, () => ({}) as never), nextCursor: null };
      },
    });
    await expect(
      loader({
        id: randomUUID(),
        workspaceId: 'workspace-a',
        callId: randomUUID(),
        source: 'carrier',
        state: 'available',
        createdAt: '2026-09-20T15:00:00.000Z',
        updatedAt: '2026-09-20T15:00:00.000Z',
        expiresAt: '2026-09-21T15:00:00.000Z',
        codec: 'audio/x-mulaw',
        sampleRate: 8000,
        channels: 2,
        segmentBytes: 64 * 1024,
      }),
    ).rejects.toThrow('oversized event page');
  });

  it('returns explicit 503 when production recording services are not attached', async () => {
    const run = await setup(false);
    try {
      const response = await run.app.inject({
        method: 'GET',
        url: `/v1/calls/${run.callId}/live-recordings`,
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('recordings_unavailable');
    } finally {
      await run.app.close();
    }
  });

  it('serves authorized manifests, bounded segment bytes, alignment, and safe replay descriptors', async () => {
    const run = await setup();
    try {
      const artifact = await liveArtifact(run);
      await run.live.state(artifact.id, 'partial', '/mnt/private/recording upload failed');
      const list = await run.app.inject({
        method: 'GET',
        url: `/v1/calls/${run.callId}/live-recordings`,
      });
      expect(list.statusCode).toBe(200);
      expect(list.body).not.toContain('/mnt/private');
      const manifest = await run.app.inject({
        method: 'GET',
        url: `/v1/calls/${run.callId}/live-recordings/${artifact.id}/manifest`,
      });
      expect(manifest.statusCode).toBe(200);
      expect(manifest.json().segments[0]).not.toHaveProperty('objectKey');
      expect(manifest.body).not.toContain(run.workspaceId + '/');
      expect(manifest.body).not.toContain('/mnt/private');
      const foreign = await run.app.inject({
        method: 'GET',
        url: `/v1/calls/${run.callId}/live-recordings/${artifact.id}/manifest`,
        headers: { 'x-workspace': 'workspace-b' },
      });
      expect(foreign.statusCode).toBe(404);

      const audio = await run.app.inject({
        method: 'GET',
        url: `/v1/calls/${run.callId}/live-recordings/${artifact.id}/segments/inbound/0/audio`,
      });
      expect(audio.statusCode).toBe(200);
      expect(audio.headers['content-type']).toContain('audio/x-mulaw');
      expect([...audio.rawPayload]).toEqual([1, 2, 3, 4]);

      const alignment = await run.app.inject({
        method: 'GET',
        url: `/v1/calls/${run.callId}/live-recordings/${artifact.id}/alignment?limit=10`,
      });
      expect(alignment.json()).toMatchObject({
        evidence: 'call-event-wall-clock-relative-to-call-start',
        precision: 'not-waveform-synchronized',
        humanHeard: false,
      });
      expect(alignment.json().transcript[0]).toMatchObject({
        atMs: 1_500,
        exactAudioAlignment: false,
      });

      const replay = await run.app.inject({
        method: 'GET',
        url: `/v1/calls/${run.callId}/live-recordings/${artifact.id}/replay`,
      });
      expect(replay.json()).toMatchObject({
        transport: 'synthetic',
        tools: 'stubbed',
        productionWrites: false,
        liveConnectors: false,
        requiredEffects: { tools: 'stubbed', productionWrites: false },
      });
    } finally {
      await run.app.close();
    }
  });

  it('streams bounded PCM-WAV playback with byte-range seek and honest gap semantics', async () => {
    const run = await setup();
    try {
      const sourceSamples = [-30_000, -1_000, 0, 1_000, 30_000];
      const artifact = await liveArtifact(
        run,
        Uint8Array.from(sourceSamples.map(linearPcmToMuLaw)),
      );
      const url = `/v1/calls/${run.callId}/live-recordings/${artifact.id}/audio/inbound`;
      const audio = await run.app.inject({ method: 'GET', url });
      expect(audio.statusCode, audio.body).toBe(200);
      expect(audio.headers['content-type']).toContain('audio/wav');
      expect(audio.headers['accept-ranges']).toBe('bytes');
      expect(audio.headers['content-length']).toBe(String(44 + sourceSamples.length * 2));
      expect(audio.headers['x-ovo-recording-completeness']).toBe('complete');
      expect(audio.rawPayload.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(audio.rawPayload.subarray(8, 12).toString('ascii')).toBe('WAVE');
      expect(audio.rawPayload.readUInt32LE(24)).toBe(8000);
      expect(audio.rawPayload.readUInt32LE(40)).toBe(sourceSamples.length * 2);
      const decoded = sourceSamples.map((_, index) => audio.rawPayload.readInt16LE(44 + index * 2));
      decoded.forEach((sample, index) =>
        expect(Math.abs(sample - sourceSamples[index]!)).toBeLessThan(1_500),
      );

      const range = await run.app.inject({
        method: 'GET',
        url,
        headers: { range: 'bytes=44-47' },
      });
      expect(range.statusCode).toBe(206);
      expect(range.headers['content-range']).toBe(`bytes 44-47/${44 + sourceSamples.length * 2}`);
      expect(range.rawPayload).toEqual(audio.rawPayload.subarray(44, 48));

      const partial = await run.live.create({
        workspaceId: run.workspaceId,
        callId: run.callId,
        retentionDays: 1,
        segmentBytes: 64 * 1024,
      });
      for (const sequence of [0, 2])
        await run.live.writeSegment({
          recording: partial,
          track: 'inbound',
          sequence,
          bytes: Uint8Array.of(0xff),
          startMs: sequence * 20,
          endMs: sequence * 20 + 0.125,
        });
      await run.live.state(partial.id, 'partial', 'one bounded segment was unavailable');
      const partialAudio = await run.app.inject({
        method: 'GET',
        url: `/v1/calls/${run.callId}/live-recordings/${partial.id}/audio/inbound`,
      });
      expect(partialAudio.statusCode).toBe(200);
      expect(partialAudio.headers['x-ovo-recording-completeness']).toBe('partial');
      expect(partialAudio.headers['x-ovo-recording-gap-count']).toBe('1');
      expect(partialAudio.headers['x-ovo-recording-timeline']).toBe(
        'concatenated-available-segments',
      );
      await run.live.state(partial.id, 'available');
      const inconsistent = await run.app.inject({
        method: 'GET',
        url: `/v1/calls/${run.callId}/live-recordings/${partial.id}/audio/inbound`,
      });
      expect(inconsistent.statusCode).toBe(409);
      expect(inconsistent.json().error.code).toBe('recording_audio_inconsistent');
    } finally {
      await run.app.close();
    }
  });

  it('creates, fences, redacts, authorizes, and integrity-checks asynchronous exports', async () => {
    const run = await setup();
    try {
      const artifact = await liveArtifact(run);
      const requested = await run.app.inject({
        method: 'POST',
        url: `/v1/calls/${run.callId}/live-recordings/${artifact.id}/exports`,
        headers: { 'x-role': 'editor' },
        payload: { idempotencyKey: 'api-export-1' },
      });
      expect(requested.statusCode).toBe(202);
      expect(requested.json()).not.toHaveProperty('outputKey');
      expect(await run.exports.work({ owner: 'export-worker' })).toEqual({
        claimed: 1,
        succeeded: 1,
        failed: 0,
      });
      const exportId = requested.json().id;
      const status = await run.app.inject({
        method: 'GET',
        url: `/v1/calls/${run.callId}/live-recordings/${artifact.id}/exports/${exportId}`,
      });
      expect(status.json()).toMatchObject({ id: exportId, state: 'succeeded' });
      expect(status.json()).not.toHaveProperty('outputKey');
      const download = await run.app.inject({
        method: 'GET',
        url: `/v1/calls/${run.callId}/live-recordings/${artifact.id}/exports/${exportId}/download`,
      });
      expect(download.statusCode).toBe(200);
      const payload = JSON.parse(download.body);
      expect(payload.transcript).toEqual([
        expect.objectContaining({ text: 'my email is [REDACTED]' }),
      ]);
      expect(payload.events).toEqual([
        { atMs: 1_500, type: 'transcript.final' },
        { atMs: 2_000, type: 'speech.generated' },
      ]);
      expect(run.audits).toEqual(
        expect.arrayContaining([expect.objectContaining({ action: 'recording.export.request' })]),
      );
      const stored = await run.exports.status(run.workspaceId, exportId);
      await run.objects.put(stored!.outputKey!, Uint8Array.of(0), 'application/json');
      const corrupted = await run.app.inject({
        method: 'GET',
        url: `/v1/calls/${run.callId}/live-recordings/${artifact.id}/exports/${exportId}/download`,
      });
      expect(corrupted.statusCode).toBe(409);
      expect(corrupted.json().error.code).toBe('recording_integrity_failed');
    } finally {
      await run.app.close();
    }
  });

  it('tombstones before failed physical deletion and rejects caller-supplied sweep time', async () => {
    const run = await setup();
    try {
      const artifact = await liveArtifact(run);
      const forbidden = await run.app.inject({
        method: 'DELETE',
        url: `/v1/calls/${run.callId}/live-recordings/${artifact.id}`,
        headers: { 'x-role': 'viewer' },
      });
      expect(forbidden.statusCode).toBe(403);
      run.objects.failDelete = true;
      const deleted = await run.app.inject({
        method: 'DELETE',
        url: `/v1/calls/${run.callId}/live-recordings/${artifact.id}`,
        headers: { 'x-role': 'editor' },
      });
      expect(deleted.statusCode).toBe(202);
      const denied = await run.app.inject({
        method: 'GET',
        url: `/v1/calls/${run.callId}/live-recordings/${artifact.id}/manifest`,
      });
      expect(denied.statusCode).toBe(404);
      const deniedAudio = await run.app.inject({
        method: 'GET',
        url: `/v1/calls/${run.callId}/live-recordings/${artifact.id}/audio/inbound`,
      });
      expect(deniedAudio.statusCode).toBe(404);
      const failedCleanup = await run.app.inject({
        method: 'POST',
        url: '/v1/recordings/retention/sweep',
        headers: { 'x-role': 'admin' },
        payload: { limit: 10 },
      });
      expect(failedCleanup.json()).toMatchObject({ cleaned: 0, failed: 1 });
      const injectedClock = await run.app.inject({
        method: 'POST',
        url: '/v1/recordings/retention/sweep',
        payload: { limit: 10, now: '2099-01-01T00:00:00.000Z' },
      });
      expect(injectedClock.statusCode).toBe(400);
      expect(run.audits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: 'recording.tombstone' }),
          expect.objectContaining({ action: 'recording.retention.sweep' }),
        ]),
      );
    } finally {
      await run.app.close();
    }
  });
});

function linearPcmToMuLaw(input: number): number {
  let sample = Math.max(-32_635, Math.min(32_635, Math.trunc(input)));
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  sample += 0x84;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (sample & mask) === 0; mask >>= 1) exponent -= 1;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}
