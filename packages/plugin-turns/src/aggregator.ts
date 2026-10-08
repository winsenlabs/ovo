import type { TranscriptSegment } from '@winsendotai/ovo-contracts';

/** Segment IDs, rather than text, carry idempotency. Two equal answers remain two turns. */
export class TurnAggregator {
  private finals = new Map<string, string>();
  private views = new Map<string, string>();
  /** Wave 8: each final's STT confidence, when the provider gives one. */
  private confidences = new Map<string, number>();
  /** Segments a turn ended on their interim text; their late finals are dropped. Survives clear(). */
  private closed = new Set<string>();

  observe(segment: TranscriptSegment): void {
    if (this.finals.has(segment.segmentId)) {
      if (segment.stability === 'interim') this.views.set(segment.segmentId, segment.text);
      return;
    }
    this.views.set(segment.segmentId, segment.text);
    if (segment.stability !== 'final') return;
    this.finals.set(segment.segmentId, segment.text);
    if (segment.confidence !== undefined)
      this.confidences.set(segment.segmentId, segment.confidence);
  }

  get view(): string {
    return joinSegments([...this.views.values()]);
  }
  get text(): string {
    return joinSegments([...this.finals.values()]);
  }
  get segments(): number {
    return this.finals.size;
  }
  /** The lowest confidence among the finals that carry one: one garbled segment is enough. */
  get confidence(): number | undefined {
    return this.confidences.size ? Math.min(...this.confidences.values()) : undefined;
  }
  /** Ends every segment that has an interim view and no final yet. */
  closeOpenSegments(): void {
    for (const id of this.views.keys()) {
      if (this.finals.has(id)) continue;
      this.closed.add(id);
      if (this.closed.size > 64) this.closed.delete(this.closed.values().next().value!);
    }
  }
  isClosed(segmentId: string): boolean {
    return this.closed.has(segmentId);
  }
  get hasText(): boolean {
    return this.text.length > 0;
  }

  take(): { text: string; segments: number } {
    const result = { text: this.text, segments: this.segments };
    this.clear();
    return result;
  }

  clear(): void {
    this.finals.clear();
    this.views.clear();
    this.confidences.clear();
  }
}

const ORDINAL = /^(?:st|nd|rd|th)\b/iu;

function joinSegments(parts: readonly string[]): string {
  return parts.reduce((text, part) => {
    const next = part.trim();
    if (!next) return text;
    // Punctuation, or an ordinal's suffix split from its number ("…around the 1" + "st.").
    const glued = /^[,.;:!?।]/u.test(next) || (/\p{N}$/u.test(text) && ORDINAL.test(next));
    return text + (text && !glued ? ' ' : '') + next;
  }, '');
}
