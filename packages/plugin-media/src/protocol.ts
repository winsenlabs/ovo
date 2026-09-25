import type { AudioFormat, PlaybackEvidence } from '@winsendotai/ovo-contracts';
import type {
  GatewayToWorkerMessage,
  MediaSessionIdentity,
  WorkerToGatewayMessage,
} from './ports.ts';

function record(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('media message must be an object');
  return parsed as Record<string, unknown>;
}

function string(value: unknown, name: string, max = 1_024): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max)
    throw new Error(`invalid ${name}`);
  return value;
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    throw new Error(`invalid ${name}`);
  return value as number;
}

function audio(value: unknown, maxBytes: number): string {
  const encoded = string(value, 'audio payload', Math.ceil((maxBytes * 4) / 3) + 4);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    throw new Error('invalid audio payload');
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length === 0 || decoded.length > maxBytes)
    throw new Error('audio frame exceeds limit');
  return encoded;
}

function evidence(value: unknown): PlaybackEvidence {
  if (value !== 'carrier-played' && value !== 'carrier-processed' && value !== 'none')
    throw new Error('invalid playback evidence');
  return value;
}

function format(value: unknown): AudioFormat {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid audio format');
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.encoding !== 'mulaw' &&
      candidate.encoding !== 'alaw' &&
      candidate.encoding !== 'pcm_s16le') ||
    ![8_000, 16_000, 22_050, 24_000, 48_000].includes(Number(candidate.sampleRate)) ||
    candidate.channels !== 1
  )
    throw new Error('invalid audio format');
  return candidate as unknown as AudioFormat;
}

export function parseGatewayMessage(raw: string, maxAudioBytes: number): GatewayToWorkerMessage {
  const message = record(raw);
  const type = string(message.type, 'message type', 64);
  if (type === 'session.open') {
    if (message.protocol !== 2) throw new Error('unsupported media protocol');
    const clear = message.clearFlushesMarkers;
    if (clear !== true && clear !== false && clear !== 'unknown')
      throw new Error('invalid clearFlushesMarkers');
    return {
      type,
      protocol: 2,
      sessionId: string(message.sessionId, 'sessionId'),
      carrierId: string(message.carrierId, 'carrierId'),
      bindingId: string(message.bindingId, 'bindingId'),
      carrierCallId: string(message.carrierCallId ?? message.callSid, 'carrierCallId'),
      streamId: string(message.streamId ?? message.streamSid, 'streamId'),
      ownerEpoch: integer(message.ownerEpoch, 'ownerEpoch', 1),
      generation: integer(message.generation, 'generation', 1),
      format: format(message.format),
      playbackEvidence: evidence(message.playbackEvidence),
      clearFlushesMarkers: clear,
      routeToken: string(message.routeToken, 'routeToken', 4_096),
    };
  }
  if (type === 'media.audio')
    return {
      type,
      payload: audio(message.payload, maxAudioBytes),
      sequenceNumber: integer(message.sequenceNumber, 'sequenceNumber'),
      timestampMs: integer(message.timestampMs, 'timestampMs'),
    };
  if (type === 'media.played')
    return { type, name: string(message.name, 'mark name'), evidence: evidence(message.evidence) };
  if (type === 'media.cleared') return { type };
  if (type === 'media.dtmf') return { type, digit: string(message.digit, 'DTMF digit', 16) };
  if (type === 'call.answered-by') {
    if (message.value !== 'human' && message.value !== 'machine' && message.value !== 'unknown')
      throw new Error('invalid answered-by value');
    return { type, value: message.value };
  }
  if (type === 'session.close') return { type, reason: string(message.reason, 'close reason') };
  throw new Error(`unsupported gateway message ${type}`);
}

export function parseWorkerMessage(raw: string, maxAudioBytes: number): WorkerToGatewayMessage {
  const message = record(raw);
  const type = string(message.type, 'message type', 64);
  if (type === 'session.accept') return { type };
  if (type === 'session.reject') return { type, reason: string(message.reason, 'reject reason') };
  if (type === 'audio') return { type, payload: audio(message.payload, maxAudioBytes) };
  if (type === 'mark') return { type, name: string(message.name, 'mark name') };
  if (type === 'clear') return { type };
  if (type === 'session.end') return { type, reason: string(message.reason, 'end reason') };
  throw new Error(`unsupported worker message ${type}`);
}

export function encodeGatewayMessage(message: GatewayToWorkerMessage): string {
  return JSON.stringify(message);
}

export function encodeWorkerMessage(message: WorkerToGatewayMessage): string {
  return JSON.stringify(message);
}

export function sameIdentity(a: MediaSessionIdentity, b: MediaSessionIdentity): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.carrierId === b.carrierId &&
    a.bindingId === b.bindingId &&
    a.carrierCallId === b.carrierCallId &&
    a.streamId === b.streamId &&
    a.ownerEpoch === b.ownerEpoch &&
    a.generation === b.generation
  );
}
