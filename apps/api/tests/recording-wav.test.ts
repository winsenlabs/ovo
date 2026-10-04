import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { RecordingManifest, RecordingSegment } from '@winsendotai/ovo-plugin-recordings';
import { recordingWavResponse } from '../src/routes/recording-lifecycle-audio.ts';

it('converts with segment backpressure and stops before the next read after abort', async () => {
  const recordingId = randomUUID();
  const segments: RecordingSegment[] = [0, 1].map((sequence) => ({
    artifactId: recordingId,
    track: 'inbound',
    sequence,
    state: 'available',
    objectKey: `workspace/${recordingId}/inbound/${sequence}.mulaw`,
    sha256: String(sequence).padStart(64, '0'),
    bytes: 1,
    startMs: sequence,
    endMs: sequence + 0.125,
    timestampEvidence: 'provider-media-timestamp',
  }));
  const manifest: RecordingManifest = {
    id: recordingId,
    workspaceId: 'workspace',
    callId: 'call',
    source: 'carrier',
    state: 'available',
    createdAt: '2026-09-20T16:00:00.000Z',
    updatedAt: '2026-09-20T16:01:00.000Z',
    expiresAt: '2026-09-21T16:00:00.000Z',
    codec: 'audio/x-mulaw',
    sampleRate: 8000,
    channels: 2,
    segmentBytes: 1024,
    segments,
    timeline: [],
  };
  const readSegment = vi.fn(
    async (
      _workspace: string,
      _call: string,
      _recording: string,
      _track: 'inbound' | 'outbound',
      sequence: number,
      options?: { signal?: AbortSignal },
    ) => {
      options?.signal?.throwIfAborted();
      return { metadata: segments[sequence]!, bytes: Uint8Array.of(0xff) };
    },
  );
  const response = await recordingWavResponse(
    { manifest: async () => manifest, readSegment },
    'workspace',
    'call',
    recordingId,
    'inbound',
  );
  const controller = new AbortController();
  const stream = response.stream(controller.signal);
  expect((await stream.next()).value?.byteLength).toBe(44);
  expect(readSegment).not.toHaveBeenCalled();
  expect([...(await stream.next()).value!]).toEqual([0, 0]);
  expect(readSegment).toHaveBeenCalledTimes(1);
  controller.abort(new Error('client disconnected'));
  await expect(stream.next()).rejects.toThrow('client disconnected');
  expect(readSegment).toHaveBeenCalledTimes(1);
});
