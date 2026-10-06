import type { SttEvent } from '@winsendotai/ovo-contracts';

/**
 * The transcript side of a realtime transcription session. Each committed input item is one
 * segment, keyed by its `item_id`: deltas build its interim text, and its completion locks it and
 * ends the turn. Completions of different turns may arrive out of order, so a final is held back
 * until every item committed before it has its own.
 */
export class RealtimeSegments {
  private revision = 0;
  private readonly partials = new Map<string, string>();
  /** Committed items still waiting for their final, oldest first. */
  private readonly order: string[] = [];
  private readonly held = new Map<string, string | undefined>();

  constructor(private readonly onEvent: (event: SttEvent) => void) {}

  committed(itemId: string): void {
    if (!this.order.includes(itemId)) this.order.push(itemId);
  }

  delta(itemId: string, delta: string): void {
    if (!delta || this.held.has(itemId)) return;
    const text = (this.partials.get(itemId) ?? '') + delta;
    this.partials.set(itemId, text);
    if (text.trim()) this.transcript(itemId, text.trim(), 'interim');
  }

  /** The item's final text; `undefined` when its transcription failed (the turn still ends). */
  completed(itemId: string, transcript: string | undefined): void {
    if (this.held.has(itemId)) return;
    this.held.set(itemId, transcript);
    if (!this.order.includes(itemId)) this.lock(itemId);
    while (this.order.length && this.held.has(this.order[0]!)) this.lock(this.order.shift()!);
  }

  private lock(itemId: string): void {
    const text = this.held.get(itemId)?.trim();
    this.partials.delete(itemId);
    if (text) this.transcript(itemId, text, 'final');
    this.onEvent({ type: 'end-of-turn' });
  }

  private transcript(segmentId: string, text: string, stability: 'interim' | 'final'): void {
    this.onEvent({
      type: 'transcript',
      segment: { segmentId, revision: ++this.revision, text, stability },
    });
  }
}
