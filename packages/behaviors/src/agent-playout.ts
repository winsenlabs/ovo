import type { SpeechReceipt } from '@winsendotai/ovo-contracts';

/**
 * Milliseconds of audio per character before this call has played enough to measure its voice:
 * slower than the ~67 ms of a typical TTS voice, so an unmeasured cut line is not taken as heard
 * too early.
 */
const DEFAULT_MS_PER_CHAR = 75;
/** Characters of completed lines needed before the call's own pace replaces the default. */
const MEASURED_CHARS = 40;
/** Shorter lines are mostly the carrier's acknowledgement delay, not speech. */
const MIN_LINE_CHARS = 8;
/** A completed line outside this pace was not timed by its playback (a mark timeout, say). */
const PACE_MS = { min: 25, max: 200 };
/** How much of a cut line must have played for the caller to have heard it. */
export const HEARD_SHARE = 0.9;

const length = (text: string) => text.replace(/\s+/g, ' ').trim().length;

/**
 * Whether the caller heard a line that was cut off, from its receipt's `playedMs`: the share of
 * the line that played, against how long the line runs at this call's pace (learnt from the lines
 * that played to the end). A line cut in its last words ("…goodby-") was heard; one cut halfway
 * was not. Without `playedMs` a cut line was never heard.
 */
export class PlayoutPace {
  private ms = 0;
  private chars = 0;

  observe(receipt: SpeechReceipt): void {
    if (receipt.state !== 'completed' || !receipt.playedMs) return;
    const chars = length(receipt.text);
    if (chars < MIN_LINE_CHARS) return;
    const pace = receipt.playedMs / chars;
    if (pace < PACE_MS.min || pace > PACE_MS.max) return;
    this.ms += receipt.playedMs;
    this.chars += chars;
  }

  heard(receipt: SpeechReceipt, share = HEARD_SHARE): boolean {
    if (receipt.state === 'completed') return true;
    if (!receipt.playedMs) return false;
    const pace = this.chars >= MEASURED_CHARS ? this.ms / this.chars : DEFAULT_MS_PER_CHAR;
    return receipt.playedMs >= share * pace * length(receipt.text);
  }
}
