import type {
  DeepgramBinding,
  OpenAiBatchSttBinding,
  OpenAiInferenceBinding,
  OpenAiTtsBinding,
} from './types.ts';

export interface StoredProviderBinding {
  id: string;
  workspaceId: string;
  provider: string;
  credentialId: string;
  config: Readonly<Record<string, unknown>>;
  updatedAt: string;
}

export function deepgramBindingFromRecord(record: StoredProviderBinding): DeepgramBinding {
  expectProvider(record, 'deepgram');
  assertKnown(record.config, [
    'model',
    'language',
    'endpointingMs',
    'utteranceEndMs',
    'connectAttempts',
    'connectTimeoutMs',
    'finishTimeoutMs',
    'maxSessionMs',
    'keepAliveMs',
    'maxInputChunkBytes',
    'maxBufferedBytes',
    'maxMessageBytes',
  ]);
  return {
    ...base(record),
    model: requiredString(record.config.model, 'model'),
    language: optionalString(record.config.language, 'language'),
    endpointingMs: integer(record.config.endpointingMs, 300, 1, 5_000, 'endpointingMs'),
    utteranceEndMs: optionalInteger(record.config.utteranceEndMs, 1_000, 60_000, 'utteranceEndMs'),
    connectAttempts: integer(record.config.connectAttempts, 2, 1, 5, 'connectAttempts'),
    connectTimeoutMs: integer(
      record.config.connectTimeoutMs,
      5_000,
      100,
      30_000,
      'connectTimeoutMs',
    ),
    finishTimeoutMs: integer(record.config.finishTimeoutMs, 3_000, 100, 30_000, 'finishTimeoutMs'),
    maxSessionMs: integer(record.config.maxSessionMs, 7_200_000, 1_000, 14_400_000, 'maxSessionMs'),
    keepAliveMs: integer(record.config.keepAliveMs, 4_000, 1_000, 5_000, 'keepAliveMs'),
    maxInputChunkBytes: integer(
      record.config.maxInputChunkBytes,
      16_384,
      160,
      65_536,
      'maxInputChunkBytes',
    ),
    maxBufferedBytes: integer(
      record.config.maxBufferedBytes,
      262_144,
      16_384,
      4_194_304,
      'maxBufferedBytes',
    ),
    maxMessageBytes: integer(
      record.config.maxMessageBytes,
      65_536,
      1_024,
      1_048_576,
      'maxMessageBytes',
    ),
  };
}

export function openAiTtsBindingFromRecord(record: StoredProviderBinding): OpenAiTtsBinding {
  expectProvider(record, 'openai');
  assertKnown(record.config, [
    'model',
    'voice',
    'instructions',
    'speed',
    'requestTimeoutMs',
    'maxInputCharacters',
    'maxResponseBytes',
    'maxOutputChunkBytes',
  ]);
  return {
    ...base(record),
    model: requiredString(record.config.model, 'model'),
    voice: requiredString(record.config.voice, 'voice'),
    instructions: optionalString(record.config.instructions, 'instructions'),
    speed: number(record.config.speed, 1, 0.25, 4, 'speed'),
    requestTimeoutMs: integer(
      record.config.requestTimeoutMs,
      30_000,
      100,
      120_000,
      'requestTimeoutMs',
    ),
    maxInputCharacters: integer(
      record.config.maxInputCharacters,
      4_096,
      1,
      4_096,
      'maxInputCharacters',
    ),
    maxResponseBytes: integer(
      record.config.maxResponseBytes,
      8_388_608,
      1_024,
      33_554_432,
      'maxResponseBytes',
    ),
    maxOutputChunkBytes: integer(
      record.config.maxOutputChunkBytes,
      3_200,
      160,
      65_536,
      'maxOutputChunkBytes',
    ),
  };
}

export function openAiBatchSttBindingFromRecord(
  record: StoredProviderBinding,
): OpenAiBatchSttBinding {
  expectProvider(record, 'openai');
  assertKnown(record.config, [
    'model',
    'language',
    'requestTimeoutMs',
    'maxAudioBytes',
    'maxResponseBytes',
  ]);
  return {
    ...base(record),
    model: requiredString(record.config.model, 'model'),
    language: optionalString(record.config.language, 'language'),
    requestTimeoutMs: integer(
      record.config.requestTimeoutMs,
      60_000,
      100,
      120_000,
      'requestTimeoutMs',
    ),
    maxAudioBytes: integer(
      record.config.maxAudioBytes,
      20_000_000,
      1_024,
      25_000_000,
      'maxAudioBytes',
    ),
    maxResponseBytes: integer(
      record.config.maxResponseBytes,
      262_144,
      1_024,
      1_048_576,
      'maxResponseBytes',
    ),
  };
}

export function openAiInferenceBindingFromRecord(
  record: StoredProviderBinding,
): OpenAiInferenceBinding {
  expectProvider(record, 'openai');
  assertKnown(record.config, ['model', 'api']);
  const api = record.config.api ?? 'responses';
  if (api !== 'responses' && api !== 'chat') throw new TypeError('api must be responses or chat');
  return { ...base(record), model: requiredString(record.config.model, 'model'), api };
}

function base(record: StoredProviderBinding) {
  return {
    workspaceId: requiredString(record.workspaceId, 'workspaceId'),
    credentialId: requiredString(record.credentialId, 'credentialId'),
    bindingVersion: `${requiredString(record.id, 'id')}:${requiredString(record.updatedAt, 'updatedAt')}`,
    model: '',
  };
}

function expectProvider(record: StoredProviderBinding, expected: string): void {
  if (record.provider !== expected) throw new TypeError(`Expected ${expected} provider binding`);
}

function assertKnown(config: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const unknown = Object.keys(config).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown provider binding fields: ${unknown.join(', ')}`);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field);
}

function integer(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || Number(selected) < minimum || Number(selected) > maximum)
    throw new TypeError(`${field} must be an integer between ${minimum} and ${maximum}`);
  return Number(selected);
}

function optionalInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
): number | undefined {
  return value === undefined ? undefined : integer(value, 0, minimum, maximum, field);
}

function number(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const selected = value ?? fallback;
  if (
    typeof selected !== 'number' ||
    !Number.isFinite(selected) ||
    selected < minimum ||
    selected > maximum
  )
    throw new TypeError(`${field} must be between ${minimum} and ${maximum}`);
  return selected;
}
