import { normalizeForMatch, type Clock } from '@winsendotai/ovo-contracts';

/**
 * How long a committed transcript waits for the word-level message that follows it ("Sent after
 * the committed transcript", the event reference) to learn its confidence. The provider answers
 * the same commit with both, so the gap should be a few milliseconds; this caps what a turn pays.
 * [unconfirmed: the gap on a live call; the session logs it as `stt_confidence_wait`.]
 */
export const CONFIDENCE_WAIT_MS = 40;
/** A word-level message later than this after its commit counts as a miss, though it is used. */
export const CONFIDENCE_SLOW_MS = 20;
/** After this many missed or slow word-level messages in a call, finals stop waiting for them. */
export const CONFIDENCE_MISSES = 2;
/**
 * No final waits past this long after its commit was sent: the turn detector gives the final
 * `userSpeechTimeoutMs` (600 ms on phone) from the commit before it ends the turn on the interim
 * text and drops the late final with its confidence. A slow commit goes out without waiting.
 */
export const CONFIDENCE_DEADLINE_MS = 500;

/**
 * Holds each commit's final until the word-level message that follows it gives the words'
 * confidence (Wave 8, call 6e1a4e3a: "Hardik?" and "Credit. Okay, so..." were heard in a cafe and
 * answered as if clear). The turn ends on the final, so the confidence must ride on it.
 *
 * The cost per call is bounded: a turn waits at most `CONFIDENCE_SLOW_MS` while the messages are
 * prompt, and the slow or missing ones, which count without reset, add at most
 * `CONFIDENCE_MISSES` x `CONFIDENCE_WAIT_MS` before the waiting stops.
 */
export class CommitConfidence {
  private held?: { text: string; atMs: number; cancel: () => void; capped: boolean };
  private misses = 0;

  constructor(
    private waiting: boolean,
    private readonly clock: Clock,
    private readonly release: (text: string, confidence?: number) => void,
    private readonly log: (event: string, fields: Record<string, unknown>) => void,
  ) {}

  /** The commit still waiting for its word-level message. */
  get pending(): string | undefined {
    return this.held?.text;
  }

  /**
   * A committed transcript: released at once, or held for its word-level message. An empty one
   * gives no final, only the end of the turn, so it never waits. `sentAtMs`: when the commit it
   * answers was sent, if the session sent it.
   */
  committed(text: string, sentAtMs?: number): void {
    this.flush();
    const atMs = this.clock.now();
    const left = sentAtMs === undefined ? Infinity : sentAtMs + CONFIDENCE_DEADLINE_MS - atMs;
    const waitMs = Math.min(CONFIDENCE_WAIT_MS, left);
    if (!this.waiting || !text.trim() || waitMs <= 0) return this.release(text);
    const capped = waitMs < CONFIDENCE_WAIT_MS;
    const cancel = this.clock.setTimeout(() => this.missed(), waitMs);
    this.held = { text, atMs, cancel, capped };
  }

  /**
   * The word-level message: releases the held commit with its confidence. One whose text is not
   * the held commit's belongs to an earlier commit, already released, and is ignored.
   */
  words(text: string | undefined, confidence: number | undefined): void {
    const held = this.held;
    if (!held) return;
    if (text !== undefined && normalizeForMatch(text) !== normalizeForMatch(held.text)) return;
    this.held = undefined;
    held.cancel();
    const waitMs = this.clock.now() - held.atMs;
    this.log('stt_confidence_wait', {
      waitMs,
      ...(confidence === undefined ? {} : { confidence: Math.round(confidence * 1000) / 1000 }),
    });
    if (waitMs > CONFIDENCE_SLOW_MS) this.miss();
    this.release(held.text, confidence);
  }

  /**
   * Releases a held commit without its confidence: a throttled commit, a newer commit or partial,
   * or the session's end (a dropped or cancelled session still delivers the caller's words).
   */
  flush(): void {
    const held = this.held;
    if (!held) return;
    this.held = undefined;
    held.cancel();
    this.release(held.text);
  }

  /** A wait the commit deadline cut short is not the provider's miss. */
  private missed(): void {
    if (!this.held?.capped) this.miss();
    this.flush();
  }

  private miss(): void {
    if (++this.misses < CONFIDENCE_MISSES || !this.waiting) return;
    this.waiting = false;
    this.log('stt_confidence_unavailable', { misses: this.misses });
  }
}
