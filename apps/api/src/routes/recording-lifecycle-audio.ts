import { createHash } from 'node:crypto';
import type {
  LiveRecordingService,
  RecordingManifest,
  RecordingSegment,
  RecordingTrack,
} from '@winsendotai/ovo-plugin-recordings';

const WAV_HEADER_BYTES = 44;
const CONVERSION_CHUNK_BYTES = 32 * 1024;
const MAX_WAV_DATA_BYTES = 0xffff_ffff - 36;

export class RecordingAudioRequestError extends Error {
  constructor(
    readonly statusCode: 409 | 416,
    readonly code: string,
    message: string,
    readonly contentRange?: string,
  ) {
    super(message);
    this.name = 'RecordingAudioRequestError';
  }
}

export interface RecordingWavResponse {
  statusCode: 200 | 206;
  headers: Readonly<Record<string, string>>;
  stream(signal?: AbortSignal): AsyncGenerator<Uint8Array>;
}

export async function recordingWavResponse(
  live: Pick<LiveRecordingService, 'manifest' | 'readSegment'>,
  workspaceId: string,
  callId: string,
  recordingId: string,
  track: RecordingTrack,
  rangeHeader?: string,
): Promise<RecordingWavResponse> {
  const manifest = await live.manifest(workspaceId, callId, recordingId);
  const plan = trackPlan(manifest, track);
  const wavBytes = WAV_HEADER_BYTES + plan.dataBytes;
  const range = parseRange(rangeHeader, wavBytes);
  const headers: Record<string, string> = {
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
    'content-length': String(range.end - range.start + 1),
    'content-type': 'audio/wav',
    'content-disposition': `inline; filename="${recordingId}-${track}.wav"`,
    etag: `"${plan.etag}"`,
    'x-ovo-recording-completeness': plan.partial ? 'partial' : 'complete',
    'x-ovo-recording-gap-count': String(plan.gaps),
    'x-ovo-recording-timeline': 'concatenated-available-segments',
  };
  if (range.partial) headers['content-range'] = `bytes ${range.start}-${range.end}/${wavBytes}`;
  return {
    statusCode: range.partial ? 206 : 200,
    headers,
    stream: (signal) =>
      streamTrack(live, workspaceId, callId, recordingId, track, plan, range, signal),
  };
}

interface TrackPlan {
  segments: RecordingSegment[];
  dataBytes: number;
  gaps: number;
  partial: boolean;
  etag: string;
}

function trackPlan(manifest: RecordingManifest, track: RecordingTrack): TrackPlan {
  if (!['available', 'partial'].includes(manifest.state))
    throw new RecordingAudioRequestError(
      409,
      'recording_audio_unavailable',
      'Recording audio is not finalized',
    );
  if (manifest.codec !== 'audio/x-mulaw' || manifest.sampleRate !== 8000) throw inconsistent();
  const all = manifest.segments
    .filter((segment) => segment.track === track)
    .sort((left, right) => left.sequence - right.sequence);
  if (!all.length) throw unavailableTrack();
  const identities = new Set<number>();
  for (const segment of all) {
    if (
      identities.has(segment.sequence) ||
      !Number.isSafeInteger(segment.sequence) ||
      segment.sequence < 0 ||
      !Number.isSafeInteger(segment.bytes) ||
      segment.bytes < 0 ||
      segment.bytes > manifest.segmentBytes ||
      segment.endMs < segment.startMs
    )
      throw inconsistent();
    identities.add(segment.sequence);
  }
  const segments = all.filter((segment) => segment.state === 'available');
  if (!segments.length) throw unavailableTrack();
  if (segments.some((segment) => !segment.objectKey || !segment.sha256 || segment.bytes === 0))
    throw inconsistent();
  const expected = all[all.length - 1]!.sequence + 1;
  const gaps = expected - segments.length;
  if (gaps < 0 || (manifest.state === 'available' && gaps !== 0)) throw inconsistent();
  const sourceBytes = segments.reduce((total, segment) => total + segment.bytes, 0);
  const dataBytes = sourceBytes * 2;
  if (!Number.isSafeInteger(dataBytes) || dataBytes > MAX_WAV_DATA_BYTES)
    throw new RecordingAudioRequestError(
      409,
      'recording_audio_unavailable',
      'Recording track exceeds PCM-WAV bounds',
    );
  const etag = createHash('sha256')
    .update(`${manifest.id}:${manifest.updatedAt}:${track}:`)
    .update(segments.map((segment) => `${segment.sequence}:${segment.sha256}`).join(','))
    .digest('hex');
  return { segments, dataBytes, gaps, partial: manifest.state !== 'available' || gaps > 0, etag };
}

interface ByteRange {
  start: number;
  end: number;
  partial: boolean;
}

function parseRange(value: string | undefined, total: number): ByteRange {
  if (!value) return { start: 0, end: total - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) throw invalidRange(total);
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw invalidRange(total);
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : total - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start >= total ||
      end < start
    )
      throw invalidRange(total);
    end = Math.min(end, total - 1);
  }
  return { start, end, partial: true };
}

async function* streamTrack(
  live: Pick<LiveRecordingService, 'readSegment'>,
  workspaceId: string,
  callId: string,
  recordingId: string,
  track: RecordingTrack,
  plan: TrackPlan,
  range: ByteRange,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  signal?.throwIfAborted();
  const header = wavHeader(plan.dataBytes);
  const headerSlice = intersection(header, 0, range);
  if (headerSlice) yield headerSlice;
  let outputOffset = WAV_HEADER_BYTES;
  for (const segment of plan.segments) {
    signal?.throwIfAborted();
    const segmentStart = outputOffset;
    const segmentEnd = segmentStart + segment.bytes * 2;
    outputOffset = segmentEnd;
    if (range.end < segmentStart || range.start >= segmentEnd) continue;
    const result = await live.readSegment(
      workspaceId,
      callId,
      recordingId,
      track,
      segment.sequence,
      { signal },
    );
    if (
      result.metadata.bytes !== segment.bytes ||
      result.metadata.sha256 !== segment.sha256 ||
      result.bytes.byteLength !== segment.bytes
    )
      throw inconsistent();
    const relevantStart = Math.max(range.start, segmentStart);
    const relevantEnd = Math.min(range.end + 1, segmentEnd);
    const sourceStart = Math.floor((relevantStart - segmentStart) / 2);
    const sourceEnd = Math.ceil((relevantEnd - segmentStart) / 2);
    for (let offset = sourceStart; offset < sourceEnd; offset += CONVERSION_CHUNK_BYTES) {
      signal?.throwIfAborted();
      const end = Math.min(sourceEnd, offset + CONVERSION_CHUNK_BYTES);
      const pcm = muLawToPcm16(result.bytes.subarray(offset, end));
      const pcmStart = segmentStart + offset * 2;
      const sliceStart = Math.max(0, relevantStart - pcmStart);
      const sliceEnd = Math.min(pcm.byteLength, relevantEnd - pcmStart);
      if (sliceEnd > sliceStart) yield pcm.subarray(sliceStart, sliceEnd);
    }
  }
}

function intersection(bytes: Uint8Array, outputStart: number, range: ByteRange) {
  const start = Math.max(range.start, outputStart);
  const end = Math.min(range.end + 1, outputStart + bytes.byteLength);
  return end > start ? bytes.subarray(start - outputStart, end - outputStart) : undefined;
}

function wavHeader(dataBytes: number): Uint8Array {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(dataBytes + 36, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function muLawToPcm16(input: Uint8Array): Uint8Array {
  const output = Buffer.allocUnsafe(input.byteLength * 2);
  for (let index = 0; index < input.byteLength; index += 1) {
    const value = ~input[index]! & 0xff;
    let magnitude = ((value & 0x0f) << 3) + 0x84;
    magnitude <<= (value & 0x70) >> 4;
    const sample = value & 0x80 ? 0x84 - magnitude : magnitude - 0x84;
    output.writeInt16LE(sample, index * 2);
  }
  return output;
}

function invalidRange(total: number) {
  return new RecordingAudioRequestError(
    416,
    'recording_range_not_satisfiable',
    'Requested audio range is not satisfiable',
    `bytes */${total}`,
  );
}

function inconsistent() {
  return new RecordingAudioRequestError(
    409,
    'recording_audio_inconsistent',
    'Recording audio manifest is inconsistent',
  );
}

function unavailableTrack() {
  return new RecordingAudioRequestError(
    409,
    'recording_audio_unavailable',
    'Recording track is unavailable',
  );
}
