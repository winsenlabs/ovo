import type { TranscriptSegment } from '@winsendotai/ovo-contracts';

/** Segment IDs, rather than text, carry idempotency. Two equal answers remain two turns. */
export class TurnAggregator {
  private finals = new Map<string, string>();
  private views = new Map<string, string>();

  observe(segment: TranscriptSegment): void {
    if (this.finals.has(segment.segmentId)) return;
    this.views.set(segment.segmentId, segment.text);
    if (segment.stability === 'final') this.finals.set(segment.segmentId, segment.text);
  }

  get view(): string { return joinSegments([...this.views.values()]); }
  get text(): string { return joinSegments([...this.finals.values()]); }
  get segments(): number { return this.finals.size; }
  get hasText(): boolean { return this.text.length > 0; }

  take(): { text: string; segments: number } {
    const result = { text: this.text, segments: this.segments };
    this.clear();
    return result;
  }

  clear(): void { this.finals.clear(); this.views.clear(); }
}

function joinSegments(parts: readonly string[]): string {
  return parts.reduce((text, part) => {
    const next = part.trim();
    if (!next) return text;
    return text + (text && !/^[,.;:!?।]/u.test(next) ? ' ' : '') + next;
  }, '');
}
