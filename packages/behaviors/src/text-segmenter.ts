const DEFAULT_MAX_SEGMENT_CHARACTERS = 240;
const DEFAULT_MAX_TOTAL_CHARACTERS = 32_000;

/** Deterministically turns provider deltas into bounded, speakable text segments. */
export class StreamingTextSegmenter {
  private buffer = '';
  private totalCharacters = 0;

  constructor(
    private readonly maxSegmentCharacters = DEFAULT_MAX_SEGMENT_CHARACTERS,
    private readonly maxTotalCharacters = DEFAULT_MAX_TOTAL_CHARACTERS,
  ) {
    if (!Number.isInteger(maxSegmentCharacters) || maxSegmentCharacters < 32)
      throw new TypeError('maxSegmentCharacters must be an integer of at least 32');
    if (!Number.isInteger(maxTotalCharacters) || maxTotalCharacters < maxSegmentCharacters)
      throw new TypeError('maxTotalCharacters must contain at least one segment');
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
      const boundary = sentenceBoundary(this.buffer, this.maxSegmentCharacters);
      if (boundary === undefined && !flush && this.buffer.length <= this.maxSegmentCharacters)
        break;
      const end = boundary ?? boundedBoundary(this.buffer, this.maxSegmentCharacters);
      const segment = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end).trimStart();
      if (segment) segments.push(segment);
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

function sentenceBoundary(text: string, maximum: number): number | undefined {
  const search = text.slice(0, maximum + 1);
  const expression = /[.!?](?:["')\]]*)\s+/gu;
  const match = expression.exec(search);
  return match ? match.index + match[0].trimEnd().length : undefined;
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
