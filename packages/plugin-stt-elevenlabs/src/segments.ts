import { normalizeForMatch, type SttEvent } from '@winsendotai/ovo-contracts';

/**
 * How long after a commit a partial that only repeats the committed words is taken as stale. The
 * live ones landed 12 and 23 ms after their commit (N5); a caller who says the same words again
 * later is heard as usual.
 */
export const STALE_PARTIAL_MS = 2_000;

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
  /** The last commit's words while a late partial of them may still arrive (N5). */
  private committed?: { words: string; atMs: number };

  constructor(
    private readonly onEvent: (event: SttEvent) => void,
    private readonly now: () => number = () => 0,
  ) {}

  onPartial(raw: string): void {
    const text = this.uncarried(raw);
    // Repeated partials carry nothing new, and the turn detector's stall fallback relies on
    // seeing only changes.
    if (!text || text === this.partial || this.stale(text)) return;
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
    const words = normalizeForMatch(text);
    this.committed = words ? { words, atMs: this.now() } : undefined;
  }

  /**
   * N5: a partial the provider sent before its commit can land after it. Equal to the committed
   * words, or a prefix of them ("Okay. य" after "Okay. याद नहीं।"), it would open a new segment and
   * a phantom turn that repeats the last one. Such partials are dropped until one brings new words.
   */
  private stale(text: string): boolean {
    const last = this.committed;
    if (!last) return false;
    const words = normalizeForMatch(text);
    if (this.now() - last.atMs <= STALE_PARTIAL_MS && (!words || last.words.startsWith(words)))
      return true;
    this.committed = undefined;
    return false;
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
