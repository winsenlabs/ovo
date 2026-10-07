import type { Clock } from '@winsendotai/ovo-contracts';

/**
 * Audio-event tags some STTs write between words ("(beep)", "[noise]", "<background noise>",
 * "*cough*", "♪"). They are not the caller speaking: a tag alone is no utterance, and a tag never
 * counts as a word towards a barge-in.
 */
const TAGS = /\([^()]*\)|\[[^\]]*\]|<[^<>]*>|\*[^*]+\*|[♪♫]+/gu;

/** The spoken words of a transcript, audio-event tags removed. */
export function spokenText(text: string): string {
  return text.replace(TAGS, ' ').replace(/\s+/gu, ' ').trim();
}

/**
 * True when the STT marked the utterance as broken off mid-word or trailing off: "tell me for-",
 * "Do you-- do I need-", "Promoter of CreditMantri is a...". In call B 15 of 67 finals ended so,
 * each one a forced endpoint while the caller was still talking.
 */
export function endsCutOff(text: string): boolean {
  return /(?:[-–—]|…|\.\.\.)\s*$/u.test(text);
}

/**
 * Holds a broken-off turn for `holdMs` (P2): the caller paused mid-sentence, or the VAD let go
 * while they still spoke. Speech or new words in the wait continue the same turn; once the wait
 * is served the turn ends on what it has.
 */
export class CutoffHold {
  private cancelTimer?: () => void;
  private served = false;

  constructor(
    private readonly clock: Clock,
    private readonly holdMs: number,
  ) {}

  /** True while `text` must wait; `expired` runs once when the wait is served. */
  holds(text: string, expired: () => void): boolean {
    if (this.served || !this.holdMs || !endsCutOff(text)) return false;
    this.cancelTimer ??= this.clock.setTimeout(() => {
      this.cancelTimer = undefined;
      this.served = true;
      expired();
    }, this.holdMs);
    return true;
  }

  /** The caller went on: a later break-off waits again. */
  resume(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.served = false;
  }
}
