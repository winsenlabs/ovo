import type { TranscriptSegment } from '@winsendotai/ovo-contracts';

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

export function retryable(code: number): boolean {
  return code === 3008 || code === 3009 || code === 1011;
}
