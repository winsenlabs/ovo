import type {
  GatewayToWorkerMessage,
  MediaSessionIdentity,
  WorkerToGatewayMessage,
} from './ports.ts';

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || !value || value.length > max)
    throw new Error(`${label} must be a non-empty string at most ${max} characters`);
  return value;
}

function epoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('invalid ownerEpoch');
  return value as number;
}

function identity(message: Record<string, unknown>): MediaSessionIdentity {
  return {
    sessionId: text(message.sessionId, 'sessionId'),
    callSid: text(message.callSid, 'callSid'),
    streamSid: text(message.streamSid, 'streamSid'),
    ownerId: text(message.ownerId, 'ownerId'),
    ownerEpoch: epoch(message.ownerEpoch),
    generation: epoch(message.generation),
  };
}

export function parseWorkerMessage(raw: string, maxAudioBytes: number): WorkerToGatewayMessage {
  const message = object(JSON.parse(raw) as unknown, 'worker message');
  const type = text(message.type, 'type');
  if (type === 'worker.hello') {
    return {
      type,
      workerId: text(message.workerId, 'workerId'),
      token: text(message.token, 'token', 4096),
    };
  }
  const id = identity(message);
  if (type === 'session.accept') return { type, ...id };
  if (type === 'media.clear') return { type, ...id };
  if (type === 'session.close')
    return { type, ...id, reason: text(message.reason, 'reason', 1024) };
  if (type === 'media.mark') return { type, ...id, name: text(message.name, 'name') };
  if (type === 'media.audio') {
    const payload = text(message.payload, 'payload', Math.ceil((maxAudioBytes * 4) / 3) + 8);
    const bytes = Buffer.from(payload, 'base64');
    if (bytes.length === 0 || bytes.length > maxAudioBytes)
      throw new Error('audio frame exceeds limit');
    return { type, ...id, payload };
  }
  throw new Error(`unsupported worker message ${type}`);
}

export function encodeGatewayMessage(message: GatewayToWorkerMessage): string {
  return JSON.stringify(message);
}

export function sameIdentity(a: MediaSessionIdentity, b: MediaSessionIdentity): boolean {
  return (
    a.callSid === b.callSid &&
    a.sessionId === b.sessionId &&
    a.streamSid === b.streamSid &&
    a.ownerId === b.ownerId &&
    a.ownerEpoch === b.ownerEpoch &&
    a.generation === b.generation
  );
}
