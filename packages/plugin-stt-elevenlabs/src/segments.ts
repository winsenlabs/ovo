import type { SttEvent } from '@winsendotai/ovo-contracts';

/**
 * The transcript side of a Scribe session. Partials of the open segment are interim revisions; a
 * committed transcript finalises the segment and ends the turn, and the next partial opens a new
 * segment.
 */
export class ScribeSegments {
  private segment = 0;
  private revision = 0;
  private partial = '';
  /** Text of a throttled commit, finalised here, that the provider still holds uncommitted. */
  private carried = '';

  constructor(private readonly onEvent: (event: SttEvent) => void) {}

  onPartial(raw: string): void {
    const text = this.uncarried(raw);
    // Repeated partials carry nothing new, and the turn detector's stall fallback relies on
    // seeing only changes.
    if (!text || text === this.partial) return;
    this.partial = text;
    this.transcript(text, 'interim');
  }

  onCommitted(raw: string): void {
    const text = this.uncarried(raw);
    this.carried = '';
    this.lock(text);
  }

  /**
   * A refused commit. Left open, its segment would be closed by the turn detector's ceiling while
   * the provider kept extending it, and the caller's next utterance would be dropped under that
   * id. The open partial is finalised here instead; the provider's later transcripts open the
   * next segment with that text stripped. [unconfirmed: the docs do not say the refused audio
   * stays in the provider's open segment; a later transcript that does not start with it is kept
   * whole.]
   */
  onThrottled(): void {
    if (!this.partial) return;
    this.carried = this.carried ? `${this.carried} ${this.partial}` : this.partial;
    this.lock(this.partial);
  }

  private lock(text: string): void {
    if (text.trim()) this.transcript(text, 'final');
    this.onEvent({ type: 'end-of-turn' });
    this.segment++;
    this.partial = '';
  }

  private uncarried(text: string): string {
    if (!this.carried || !text.startsWith(this.carried)) return text;
    return text.slice(this.carried.length).trimStart();
  }

  private transcript(text: string, stability: 'interim' | 'final'): void {
    this.onEvent({
      type: 'transcript',
      segment: { segmentId: String(this.segment), revision: ++this.revision, text, stability },
    });
  }
}
