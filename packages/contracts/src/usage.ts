import { z } from 'zod';

export const USAGE_UNITS = [
  'audio_seconds',
  'session_seconds',
  'call_seconds',
  'characters',
  'input_tokens',
  'output_tokens',
  'audio_output_tokens',
  'cache_read_input_tokens',
  'cache_write_input_tokens',
  'uncached_input_tokens',
] as const;
export const UsageUnit = z.enum(USAGE_UNITS);
export type UsageUnit = (typeof USAGE_UNITS)[number];

export type UsageOperation = 'carrier' | 'stt' | 'tts' | 'inference';

export interface UsageMeter {
  provider: string;
  operation: UsageOperation;
  unit: UsageUnit;
  /** Decimal string. */
  quantity: string;
  state: 'estimated' | 'reconciled';
  /** Required. Synthesize `${provider}:${sessionId}:${n}` when the provider gives none. */
  requestId: string;
  elapsedMs: number;
}

export type UsageSink = (meter: UsageMeter) => void;

/** The meter-key operation segment each operation has used since v1 (`cost-runtime.ts`). */
const OPERATION_SEGMENT: Readonly<Record<UsageOperation, string>> = Object.freeze({
  carrier: 'carrier',
  stt: 'streaming-stt',
  tts: 'streaming-tts',
  inference: 'inference',
});

/**
 * `${provider}.${operation segment}.${unit}`. Reproduces 'deepgram.streaming-stt.audio_seconds',
 * 'openai.streaming-tts.characters', 'twilio.carrier.audio_seconds' and 'openai.inference.*_tokens'.
 * `op` overrides the operation segment (for example 'batch-stt').
 */
export const meterKey = (
  meter: Pick<UsageMeter, 'provider' | 'operation' | 'unit'>,
  op?: string,
): string => `${meter.provider}.${op ?? OPERATION_SEGMENT[meter.operation]}.${meter.unit}`;
