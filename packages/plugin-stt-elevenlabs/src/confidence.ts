import type { Clock } from '@winsendotai/ovo-contracts';

/**
 * How long a committed transcript waits for the word-level message that follows it ("Sent after
 * the committed transcript", the event reference) to learn its confidence. The provider sends both
 * for the same commit, so the wait is normally a few milliseconds; this caps it. [unconfirmed: the
 * gap between the two on a live call; the session logs it as `stt_confidence_wait`.]
 */
export const CONFIDENCE_WAIT_MS = 120;
/** After this many commits in a row without their word-level message, the session stops waiting. */
export const CONFIDENCE_MISSES = 2;

/**
 * Holds each commit's final until the word-level message that follows it gives the words'
 * confidence (Wave 8, call 6e1a4e3a: "Hardik?" and "Credit. Okay, so..." were heard in a cafe and
 * answered as if clear). The turn ends on the final, so the confidence must ride on it. A provider
 * that never sends the message costs at most `CONFIDENCE_MISSES` waits per call.
 */
export class CommitConfidence {
  private held?: { text: string; atMs: number; cancel: () => void };
  private misses = 0;

  constructor(
    private waiting: boolean,
    private readonly clock: Clock,
    private readonly release: (text: string, confidence?: number) => void,
    private readonly log: (event: string, fields: Record<string, unknown>) => void,
  ) {}

  /** A committed transcript: released at once, or held for its word-level message. */
  committed(text: string): void {
    this.flush();
    if (!this.waiting) return this.release(text);
    const atMs = this.clock.now();
    const cancel = this.clock.setTimeout(() => this.missed(), CONFIDENCE_WAIT_MS);
    this.held = { text, atMs, cancel };
  }

  /** The word-level message: releases the held commit with its confidence. */
  words(confidence: number | undefined): void {
    const held = this.held;
    if (!held) return;
    this.held = undefined;
    held.cancel();
    this.misses = 0;
    this.log('stt_confidence_wait', {
      waitMs: this.clock.now() - held.atMs,
      ...(confidence === undefined ? {} : { confidence: Math.round(confidence * 1000) / 1000 }),
    });
    this.release(held.text, confidence);
  }

  /** Releases a held commit without its confidence (a throttled commit or a newer one). */
  flush(): void {
    const held = this.held;
    if (!held) return;
    this.held = undefined;
    held.cancel();
    this.release(held.text);
  }

  /** The session ended: a held commit is dropped with it. */
  dispose(): void {
    this.held?.cancel();
    this.held = undefined;
  }

  private missed(): void {
    if (++this.misses >= CONFIDENCE_MISSES) {
      this.waiting = false;
      this.log('stt_confidence_unavailable', { misses: this.misses });
    }
    this.flush();
  }
}
