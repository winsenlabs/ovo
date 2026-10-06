import type { Clock, MediaDuplex } from '@winsendotai/ovo-contracts';

export type AnsweredBy = 'human' | 'machine' | 'unknown';

/** What the gate releases: the turn driver. */
export interface AnsweredByTarget {
  /** Run the speak-first opening, with the verdict that released it, if any. */
  opening(answeredBy?: AnsweredBy): void;
  /** An answering machine picked up. False when the behaviour leaves the call as it is. */
  voicemail(): boolean;
}

/**
 * Holds a speak-first opening until the carrier says who answered, so a greeting is not spent on a
 * voicemail box. A human or an undecided verdict opens at once; no verdict opens after `timeoutMs`.
 * A machine goes to voicemail instead of the opening, or cuts the opening off if it came late; a
 * behaviour that does not handle voicemail gets its opening as if the verdict were undecided.
 */
export class AnsweredByGate {
  private state: 'idle' | 'holding' | 'opened' | 'voicemail' = 'idle';
  private cancelTimer?: () => void;
  /** A verdict that arrived before the opening was asked for. */
  private early?: AnsweredBy;

  /** `timeoutMs` is set when the carrier was asked to detect a machine; absent, nothing is held. */
  constructor(
    private readonly clock: Clock,
    private readonly timeoutMs: number | undefined,
    private readonly target: AnsweredByTarget,
  ) {}

  /** Called once at engine start, when the behaviour speaks first. */
  speakFirst(): void {
    if (this.state !== 'idle') return;
    if (this.early || this.timeoutMs === undefined) return this.open(this.early);
    this.state = 'holding';
    this.cancelTimer = this.clock.setTimeout(() => this.open(), this.timeoutMs);
  }

  /** Hears the carrier's verdict on `media`. The returned function also stops the hold timer. */
  listen(media: MediaDuplex, observed: (result: AnsweredBy) => void): () => void {
    const unsubscribe =
      media.onAnsweredBy?.((result) => {
        observed(result);
        this.verdict(result);
      }) ?? (() => undefined);
    return () => {
      unsubscribe();
      this.cancelTimer?.();
    };
  }

  verdict(result: AnsweredBy): void {
    if (this.state === 'voicemail') return;
    if (result === 'machine' && this.target.voicemail()) {
      this.cancelTimer?.();
      this.state = 'voicemail';
    } else if (this.state === 'holding') this.open(result);
    else if (this.state === 'idle') this.early = result;
  }

  private open(answeredBy?: AnsweredBy): void {
    if (this.state !== 'idle' && this.state !== 'holding') return;
    this.cancelTimer?.();
    this.state = 'opened';
    this.target.opening(answeredBy);
  }
}
