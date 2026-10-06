import type { TranscriptSegment } from '@winsendotai/ovo-contracts';

/** Segment IDs, rather than text, carry idempotency. Two equal answers remain two turns. */
export class TurnAggregator {
  private finals = new Map<string, string>();
  private views = new Map<string, string>();
  /** Segments a turn ended on their interim text; their late finals are dropped. Survives clear(). */
  private closed = new Set<string>();

  observe(segment: TranscriptSegment): void {
    if (this.finals.has(segment.segmentId)) {
      if (segment.stability === 'interim') this.views.set(segment.segmentId, segment.text);
      return;
    }
    this.views.set(segment.segmentId, segment.text);
    if (segment.stability === 'final') this.finals.set(segment.segmentId, segment.text);
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
  }
}

function joinSegments(parts: readonly string[]): string {
  return parts.reduce((text, part) => {
    const next = part.trim();
    if (!next) return text;
    return text + (text && !/^[,.;:!?।]/u.test(next) ? ' ' : '') + next;
  }, '');
}
