import type { TranscriptSegment } from '@winsendotai/ovo-contracts';

export class AssemblyAiProviderError extends Error {
  constructor(
    message: string,
    readonly code: number | 'model-mismatch' | 'protocol' | 'connect-timeout',
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AssemblyAiProviderError';
  }
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function milliseconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Begin's session id, or the failure that rejects the handshake. */
export function beginId(
  value: Record<string, unknown>,
  model: string,
): string | AssemblyAiProviderError {
  const actual = record(value.configuration)?.model;
  if (typeof actual === 'string' && actual !== model)
    return new AssemblyAiProviderError(
      `AssemblyAI model mismatch: ${actual}`,
      'model-mismatch',
      false,
    );
  if (typeof value.id !== 'string' || !value.id)
    return new AssemblyAiProviderError('Begin has no id', 'protocol', false);
  return value.id;
}

/** Termination's billed session length; undefined when it is missing or invalid. */
export function sessionDuration(value: Record<string, unknown>): number | undefined {
  const seconds = value.session_duration_seconds;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
    ? seconds
    : undefined;
}

/** An Error message as a typed failure; a missing code is treated as an internal error. */
export function providerError(value: Record<string, unknown>): AssemblyAiProviderError {
  const code = typeof value.error_code === 'number' ? value.error_code : 1011;
  return new AssemblyAiProviderError(
    String(value.error ?? 'AssemblyAI error'),
    code,
    retryable(code),
  );
}

/** A Turn message as a transcript segment at `revision`; undefined when it is malformed. */
export function turnSegment(
  value: Record<string, unknown>,
  revision: number,
): TranscriptSegment | undefined {
  const order = value.turn_order;
  if (!Number.isSafeInteger(order) || typeof value.transcript !== 'string') return undefined;
  return {
    segmentId: String(order),
    revision,
    text: value.transcript,
    stability: value.end_of_turn === true ? 'final' : 'interim',
    formatted: value.turn_is_formatted === true,
    words: Array.isArray(value.words) ? value.words.flatMap(wordOf) : undefined,
  };
}

export function wordOf(value: unknown): NonNullable<TranscriptSegment['words']>[number][] {
  const word = record(value);
  if (
    !word ||
    typeof word.text !== 'string' ||
    !Number.isFinite(word.start) ||
    !Number.isFinite(word.end)
  )
    return [];
  return [
    {
      text: word.text,
      startMs: Number(word.start),
      endMs: Number(word.end),
      final: word.word_is_final === true,
    },
  ];
}

/** 1006 is an abnormal closure with no close frame: the connection dropped, not a refusal. */
export function retryable(code: number): boolean {
  return code === 3008 || code === 3009 || code === 1011 || code === 1006;
}

/** A connection lost mid-session without a usable close code, typed like a 1006 close. */
export function connectionDrop(detail: string): AssemblyAiProviderError {
  return new AssemblyAiProviderError(`AssemblyAI ${detail}`, 1006, true);
}
