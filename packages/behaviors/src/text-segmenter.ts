import { sentenceBoundary } from './sentence-boundary.ts';

const DEFAULT_MAX_SEGMENT_CHARACTERS = 240;
const DEFAULT_MAX_TOTAL_CHARACTERS = 32_000;
/** A clause mark ends the first segment only after this many words (LAT-9). */
export const DEFAULT_MIN_FIRST_WORDS = 3;

/** Deterministically turns provider deltas into bounded, speakable text segments. */
export class StreamingTextSegmenter {
  private buffer = '';
  private totalCharacters = 0;
  private first = true;

  constructor(
    private readonly maxSegmentCharacters = DEFAULT_MAX_SEGMENT_CHARACTERS,
    private readonly maxTotalCharacters = DEFAULT_MAX_TOTAL_CHARACTERS,
    private readonly options: {
      language?: string;
      firstSegmentMaxChars?: number;
      minFirstWords?: number;
    } = {},
  ) {
    if (!Number.isInteger(maxSegmentCharacters) || maxSegmentCharacters < 32)
      throw new TypeError('maxSegmentCharacters must be an integer of at least 32');
    if (!Number.isInteger(maxTotalCharacters) || maxTotalCharacters < maxSegmentCharacters)
      throw new TypeError('maxTotalCharacters must contain at least one segment');
    if (
      !Number.isInteger(options.firstSegmentMaxChars ?? 60) ||
      (options.firstSegmentMaxChars ?? 60) < 1
    )
      throw new TypeError('firstSegmentMaxChars must be a positive integer');
    const minFirstWords = options.minFirstWords ?? DEFAULT_MIN_FIRST_WORDS;
    if (!Number.isInteger(minFirstWords) || minFirstWords < 0)
      throw new TypeError('minFirstWords must be a non-negative integer');
  }

  push(delta: string): string[] {
    if (!delta) return [];
    this.totalCharacters += delta.length;
    if (this.totalCharacters > this.maxTotalCharacters)
      throw new Error('Streaming response exceeded the configured text budget');
    this.buffer += delta;
    return this.take(false);
  }

  finish(): string[] {
    return this.take(true);
  }

  private take(flush: boolean): string[] {
    const segments: string[] = [];
    while (this.buffer.trim()) {
      const maximum = this.first
        ? Math.min(this.maxSegmentCharacters, this.options.firstSegmentMaxChars ?? 60)
        : this.maxSegmentCharacters;
      const boundary = sentenceBoundary(
        this.buffer,
        maximum,
        this.options.language ?? 'en',
        flush,
        this.first,
        this.options.minFirstWords ?? DEFAULT_MIN_FIRST_WORDS,
      );
      if (boundary === undefined && !flush && this.buffer.length <= maximum) break;
      const end = boundary ?? boundedBoundary(this.buffer, maximum);
      const segment = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end).trimStart();
      if (segment) {
        segments.push(segment);
        this.first = false;
      }
      if (flush && boundary === undefined && this.buffer.length <= this.maxSegmentCharacters) {
        const remainder = this.buffer.trim();
        this.buffer = '';
        if (remainder) segments.push(remainder);
      }
    }
    if (flush && !this.buffer.trim()) this.buffer = '';
    return segments;
  }
}

function boundedBoundary(text: string, maximum: number): number {
  if (text.length <= maximum) return text.length;
  const whitespace = text.lastIndexOf(' ', maximum);
  if (whitespace >= Math.floor(maximum / 2)) return whitespace;
  const splitsSurrogate =
    text.charCodeAt(maximum - 1) >= 0xd800 &&
    text.charCodeAt(maximum - 1) <= 0xdbff &&
    text.charCodeAt(maximum) >= 0xdc00 &&
    text.charCodeAt(maximum) <= 0xdfff;
  return splitsSurrogate ? maximum - 1 : maximum;
}
