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
