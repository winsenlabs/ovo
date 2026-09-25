import { createHash } from 'node:crypto';
import type { TelemetryEvent } from './telemetry-types.ts';

const ID_MAX = 200;
const TEXT_MAX = 500;
const payloadKeys = 64;

function requiredText(value: string, name: string, max = ID_MAX): void {
  if (!value || value.length > max) throw new Error(`Invalid telemetry ${name}`);
}

function optionalText(value: string | undefined, name: string, max = ID_MAX): void {
  if (value !== undefined) requiredText(value, name, max);
}

export function validateTelemetryEvent(event: TelemetryEvent): void {
  if (event.schemaVersion !== 1) throw new Error('Unsupported telemetry schema version');
  requiredText(event.eventId, 'eventId');
  requiredText(event.workspaceId, 'workspaceId');
  requiredText(event.callId, 'callId');
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 0)
    throw new Error('Invalid telemetry sequence');
  if (!Number.isFinite(Date.parse(event.occurredAt))) throw new Error('Invalid occurredAt');
  optionalText(event.agentId, 'agentId');
  optionalText(event.releaseId, 'releaseId');
  optionalText(event.provider, 'provider');
  optionalText(event.model, 'model');
  optionalText(event.language, 'language');
  optionalText(event.turnId, 'turnId');
  optionalText(event.stageId, 'stageId');
  optionalText(event.stage, 'stage', TEXT_MAX);
  optionalText(event.operationId, 'operationId');
  optionalText(event.segmentId, 'segmentId');
  if (
    event.responseEpoch !== undefined &&
    (!Number.isSafeInteger(event.responseEpoch) || event.responseEpoch < 0)
  )
    throw new Error('Invalid response epoch');
  if (
    event.durationMs !== undefined &&
    (!Number.isFinite(event.durationMs) || event.durationMs < 0)
  )
    throw new Error('Invalid duration');
  if (Object.keys(event.payload ?? {}).length > payloadKeys)
    throw new Error('Telemetry payload is too large');
  if (Buffer.byteLength(JSON.stringify(event.payload ?? {})) > 16 * 1024)
    throw new Error('Telemetry payload exceeds 16 KiB');
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function telemetryEventHash(event: TelemetryEvent): Buffer {
  validateTelemetryEvent(event);
  return createHash('sha256').update(stable(event)).digest();
}
