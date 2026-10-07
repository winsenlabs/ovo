import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  LiveRecordingService,
  LocalRecordingBackend,
  RecordingRetentionService,
  RecordingUnavailableError,
  type RecordingTrack,
} from '@winsendotai/ovo-plugin-recordings';
import { PostgresRecordingRepository } from '@winsendotai/ovo-plugin-recordings/production';
import { CALL, WORKSPACE, recordedCall } from './recording-call-fixture.ts';
import { LIVE_RECORDING_SEGMENT_BYTES } from '../src/session-recording.ts';

const databaseUrl = process.env.RECORDING_TEST_DATABASE_URL;
const DAY = 86_400_000;
/** Recognisable audio: byte i of a stream is `seed + i` (mod 256). */
const audio = (bytes: number, seed: number) =>
  Uint8Array.from({ length: bytes }, (_, i) => (seed + i) % 256);

async function files(directory: string): Promise<string[]> {
  return (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

/**
 * No live call of 2026-10-07 left a recording: every agent was published with `recording: false`
 * (`release.json`, and the agent scripts), while the CreditMantri flow told callers "this call is
 * recorded". These run an agent with `recording: true` through the production worker path into
 * PostgreSQL and the shared recordings directory, then through retention.
 */
describe.skipIf(!databaseUrl)('a recorded live call, end to end', () => {
  const schema = `recording_${randomUUID().replaceAll('-', '')}`;
  let directory: string;
  let repository: PostgresRecordingRepository;
  let objects: LocalRecordingBackend;
  let service: LiveRecordingService;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ovo-recorded-call-'));
    repository = new PostgresRecordingRepository({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
    });
    await repository.pool.query(`CREATE SCHEMA ${schema}`);
    await repository.migrate();
    objects = new LocalRecordingBackend(directory);
    service = new LiveRecordingService(repository, objects);
  });

  afterAll(async () => {
    await repository.pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await repository.close();
    objects.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('records both sides of the call, keeps it for the retention period, then deletes it', async () => {
    const call = await recordedCall({ recording: true, recordings: service, retentionDays: 7 });
    // 40 s of caller audio, more than one live segment, and 3 s of the agent.
    const caller = audio(320_000, 7);
    const agent = audio(24_000, 99);
    try {
      await call.composed();
      call.caller(caller);
      await call.agent(agent);
      await vi.waitFor(() =>
        expect(call.heard.reduce((sum, bytes) => sum + bytes.byteLength, 0)).toBe(caller.length),
      );
      await call.hangUp();
    } finally {
      await call.close();
    }
    const [artifact, ...others] = await service.list(WORKSPACE, CALL);
    expect(others).toEqual([]);
    expect(artifact).toMatchObject({
      state: 'available',
      segmentBytes: LIVE_RECORDING_SEGMENT_BYTES,
    });
    expect(Date.parse(artifact!.expiresAt) - Date.parse(artifact!.createdAt)).toBe(7 * DAY);
    const manifest = await service.manifest(WORKSPACE, CALL, artifact!.id);
    const track = async (name: RecordingTrack) => {
      const segments = manifest.segments.filter((segment) => segment.track === name);
      const parts = await Promise.all(
        segments.map(async (segment) => {
          const read = await service.readSegment(
            WORKSPACE,
            CALL,
            artifact!.id,
            name,
            segment.sequence,
          );
          return read.bytes;
        }),
      );
      return { segments: segments.length, bytes: Buffer.concat(parts) };
    };
    const inbound = await track('inbound');
    expect(inbound.segments).toBe(2);
    expect(inbound.bytes.equals(Buffer.from(caller))).toBe(true);
    const outbound = await track('outbound');
    expect(outbound.bytes.equals(Buffer.from(agent))).toBe(true);
    expect(call.audits.filter(([type]) => type === 'recording.status')).toEqual([
      [
        'recording.status',
        { state: 'recording', artifactId: artifact!.id, expiresAt: artifact!.expiresAt },
      ],
      [
        'recording.status',
        {
          state: 'available',
          artifactId: artifact!.id,
          inboundBytes: caller.length,
          outboundBytes: agent.length,
        },
      ],
    ]);

    // Retention: the next sweep after the 7 days deletes the audio, not only the metadata.
    expect(await files(directory)).toHaveLength(manifest.segments.length);
    const later = Date.parse(artifact!.expiresAt) + 1;
    const retention = new RecordingRetentionService(repository, objects, () => later);
    expect(await retention.sweep()).toMatchObject({ tombstoned: 1, cleaned: 1, failed: 0 });
    expect(await files(directory)).toEqual([]);
    await expect(service.manifest(WORKSPACE, CALL, artifact!.id)).rejects.toBeInstanceOf(
      RecordingUnavailableError,
    );
  });
});

describe('a live call whose recording cannot start', () => {
  it('is still answered, unrecorded, and its evidence says why', async () => {
    const broken = {
      create: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
      },
    } as unknown as LiveRecordingService;
    const call = await recordedCall({ recording: true, recordings: broken });
    try {
      await call.composed();
      call.caller(audio(1_600, 1));
      await vi.waitFor(() => expect(call.heard).toHaveLength(10));
      await call.hangUp();
    } finally {
      await call.close();
    }
    expect(call.audits).toContainEqual([
      'recording.status',
      { state: 'unavailable', error: 'Error: connect ECONNREFUSED 127.0.0.1:5432' },
    ]);
  });

  it('says so when the agent does not record', async () => {
    const call = await recordedCall({ recording: false });
    try {
      await call.composed();
      await call.hangUp();
    } finally {
      await call.close();
    }
    expect(call.audits).toContainEqual(['recording.status', { state: 'off' }]);
  });
});
