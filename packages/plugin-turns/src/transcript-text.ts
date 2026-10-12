import { countWords, type Clock } from '@winsendotai/ovo-contracts';

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
 * Holds a turn whose words trail off for `holdMs` (P2; Wave 8 adds "and", "to the", a comma,
 * "around the 1": see utterance-end.ts): the caller paused mid-sentence, or the VAD let go while
 * they still spoke. Speech or new words in the wait continue the same turn; once the wait is
 * served the turn ends on what it has.
 */
export class CutoffHold {
  private cancelTimer?: () => void;
  private served = false;
  /** Wave 9: the words the turn's last hold began on, until the turn ends (`clear`). */
  private heldOn?: string;

  constructor(
    private readonly clock: Clock,
    private readonly holdMs: number,
  ) {}

  /**
   * True while unfinished words must wait; `expired` runs once when the wait is served. `holdMs`
   * replaces the configured wait for this one (Wave 9: words that stop mid-thought wait longer).
   */
  holds(unfinished: boolean, expired: () => void, holdMs = this.holdMs, text?: string): boolean {
    if (this.served || !holdMs || !unfinished) return false;
    if (!this.cancelTimer) this.heldOn = text;
    this.cancelTimer ??= this.clock.setTimeout(() => {
      this.cancelTimer = undefined;
      this.served = true;
      expired();
    }, holdMs);
    return true;
  }

  /**
   * The caller went on, or (Wave 9) went quiet: a later break-off waits again, timed from the
   * silence. Call 10d5ef30 turn 1: the stall committed "…nice in-" while the caller was still
   * talking, so its hold ran out under their words, and the VAD stop then ended the turn at once.
   */
  resume(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.served = false;
  }

  /**
   * Wave 9: `view` carries on the words a hold began on with at most `maxWords` more ("…it should
   * still be a" + "built-in."): complete, it ends the turn as a short answer would, not after the
   * stall (call 10d5ef30 turn 16 ended 633 ms after "built-in." as a turn of its own).
   */
  carriesOn(view: string, language: string, maxWords: number): boolean {
    const held = this.heldOn;
    if (!held || view.length <= held.length || !view.startsWith(held)) return false;
    return countWords(view.slice(held.length), language) <= maxWords;
  }

  /** The turn ended: nothing is held for the next one. */
  clear(): void {
    this.resume();
    this.heldOn = undefined;
  }
}
