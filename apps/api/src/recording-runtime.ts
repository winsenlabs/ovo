import { definePlugin, type Context } from '@winsendotai/ovo-runtime';
import { Cap, MULAW_8K, type AudioFormat } from '@winsendotai/ovo-contracts';
import { fixtureTrackToMulaw, type FixtureRecordingWriter } from '@winsendotai/ovo-fixture-calls';
import type { RecordingArchive } from '@winsendotai/ovo-plugin-recordings';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import {
  createProductionRecordingsPlugin,
  PRODUCTION_RECORDINGS_CONFIG_SCHEMA,
  RECORDING_SERVICE_KEYS,
  type ProductionRecordingServices,
  type ProductionRecordingsConfig,
} from '@winsendotai/ovo-plugin-recordings/production';
import { createRecordingExportInputLoader } from './routes/recording-lifecycle.ts';

export type ApiProductionRecordingsOptions = ProductionRecordingsConfig;

export const API_PRODUCTION_RECORDING_SERVICE_KEY = RECORDING_SERVICE_KEYS.production;
export { PRODUCTION_RECORDINGS_CONFIG_SCHEMA };

export function createRecordingRuntimePlugin(options: ApiProductionRecordingsOptions) {
  const template = createApiProductionRecordingsPlugin(options, {
    listCallEvents: async () => {
      throw new Error('Recording runtime is not initialized');
    },
  });
  return definePlugin({ ...template.manifest, requires: ['controlStore'] }, async (ctx, config) => {
    const plugin = createApiProductionRecordingsPlugin(
      options,
      ctx.get('controlStore') as ControlStore,
    );
    await plugin.apply(ctx, config);
  });
}

/** Binds exports to repository-verified workspace/call metadata and durable call events. */
export function createApiProductionRecordingsPlugin(
  options: ApiProductionRecordingsOptions,
  store: Pick<ControlStore, 'listCallEvents'>,
) {
  return createProductionRecordingsPlugin(options, {
    loadExportInput: createRecordingExportInputLoader(store),
  });
}

export function getProductionRecordingServices(
  context: Pick<Context, 'get'>,
): ProductionRecordingServices | undefined {
  return context.get(API_PRODUCTION_RECORDING_SERVICE_KEY) as
    ProductionRecordingServices | undefined;
}

interface FixtureRecordingChunk {
  atMs: number;
  bytesBase64: string;
}

export interface FixtureRecordingPayload {
  format: AudioFormat;
  tracks: Record<'caller' | 'agent', FixtureRecordingChunk[]>;
}

const MAX_TRACK_BYTES = 5 * 1024 * 1024 - 45;

/** Child-side capture stays in memory until the parent persists the completed test call. */
export function createFixtureRecordingPort(format: AudioFormat) {
  return {
    open(): FixtureRecordingWriter {
      const tracks: FixtureRecordingPayload['tracks'] = { caller: [], agent: [] };
      const size = { caller: 0, agent: 0 };
      return {
        write(track, bytes, atMs) {
          size[track] += bytes.byteLength;
          if (size[track] > MAX_TRACK_BYTES)
            throw new Error('Fixture recording track exceeds 5 MiB');
          tracks[track].push({ atMs, bytesBase64: Buffer.from(bytes).toString('base64') });
        },
        finish(): FixtureRecordingPayload {
          return { format, tracks };
        },
      };
    },
  };
}

/** Parent-side persistence; no row is created unless recording was enabled and captured. */
export async function persistFixtureRecording(input: {
  context: Pick<Context, 'get'>;
  workspaceId: string;
  callId: string;
  payload: unknown;
}): Promise<{ id: string; source: 'fixture'; tracks: Record<string, string> }> {
  const payload = parseFixtureRecording(input.payload);
  const tracks = Object.fromEntries(
    (['caller', 'agent'] as const).map((track) => [
      track,
      fixtureTrackToMulaw(
        payload.format,
        payload.tracks[track].map((chunk) => Buffer.from(chunk.bytesBase64, 'base64')),
      ),
    ]),
  ) as Record<'caller' | 'agent', Uint8Array>;
  if (!tracks.caller.byteLength && !tracks.agent.byteLength)
    throw new Error('Enabled fixture recording contained no audio');
  const archive = input.context.get(Cap.recordings) as RecordingArchive | undefined;
  if (archive) {
    const records: Record<string, string> = {};
    for (const track of ['caller', 'agent'] as const) {
      if (!tracks[track].byteLength) continue;
      const record = await archive.put({
        workspaceId: input.workspaceId,
        callId: input.callId,
        wav: mulawWav(tracks[track]),
        retentionDays: 30,
        source: 'fixture',
      });
      records[track] = record.id;
    }
    return { id: records.agent ?? records.caller!, source: 'fixture', tracks: records };
  }
  const production = getProductionRecordingServices(input.context);
  if (!production) throw new Error('Fixture recording storage is unavailable');
  const recording = await production.live.create({
    workspaceId: input.workspaceId,
    callId: input.callId,
    retentionDays: 30,
  });
  try {
    await production.live.state(recording.id, 'active');
    for (const [track, bytes] of [
      ['caller', tracks.caller],
      ['agent', tracks.agent],
    ] as const) {
      if (!bytes.byteLength) continue;
      await production.live.writeSegment({
        recording,
        track: track === 'caller' ? 'inbound' : 'outbound',
        sequence: 0,
        bytes,
        startMs: 0,
        endMs: bytes.byteLength / 8,
      });
    }
    await production.live.state(recording.id, 'finalizing');
    await production.live.state(recording.id, 'available');
    return {
      id: recording.id,
      source: 'fixture',
      tracks: {
        ...(tracks.caller.byteLength ? { caller: recording.id } : {}),
        ...(tracks.agent.byteLength ? { agent: recording.id } : {}),
      },
    };
  } catch (error) {
    await production.live
      .state(
        recording.id,
        'failed',
        error instanceof Error ? error.message : 'Fixture recording failed',
      )
      .catch(() => undefined);
    throw error;
  }
}

function parseFixtureRecording(value: unknown): FixtureRecordingPayload {
  if (!value || typeof value !== 'object') throw new Error('Invalid fixture recording payload');
  const payload = value as FixtureRecordingPayload;
  if (
    !payload.format ||
    !['mulaw', 'alaw', 'pcm_s16le'].includes(payload.format.encoding) ||
    !Array.isArray(payload.tracks?.caller) ||
    !Array.isArray(payload.tracks?.agent)
  )
    throw new Error('Invalid fixture recording payload');
  for (const track of ['caller', 'agent'] as const)
    for (const chunk of payload.tracks[track])
      if (typeof chunk.bytesBase64 !== 'string' || !Number.isFinite(chunk.atMs))
        throw new Error('Invalid fixture recording chunk');
  return payload;
}

function mulawWav(bytes: Uint8Array): Uint8Array {
  const wav = Buffer.alloc(44 + bytes.byteLength + (bytes.byteLength % 2));
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.byteLength - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(7, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(MULAW_8K.sampleRate, 24);
  wav.writeUInt32LE(MULAW_8K.sampleRate, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(bytes.byteLength, 40);
  wav.set(bytes, 44);
  return wav;
}
