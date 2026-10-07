import { TRANSFER_REASON_PREFIX, type SpeechReceipt } from '@winsendotai/ovo-contracts';
import { PlayoutPace } from './agent-playout.ts';

/**
 * The agent's own decision to end the call, held until the goodbye has actually played.
 *
 * A turn arms it (a decision outcome with `end`, or the LLM's `end_call`). The call is complete only
 * once that turn has finished generating and every line it said has a completed receipt, including
 * lines streamed before the model asked to end. An interrupted line disarms it: a caller who barges
 * in on the goodbye has something to say, so the call stays open for the next turn.
 *
 * A flow's ending is different (P4): the flow has reached a terminal node, and nothing the caller
 * says next can move it. Its goodbye is `terminal`; a caller who barges in on it after one of its
 * lines played ends the call there and then. One who cut it before any line played gets it once
 * more: the next turn `close`s the call with it, and that close is `final`: a barge-in no longer
 * disarms it, and the call ends once its lines are out. An opt-out's closing line is terminal too.
 *
 * A line cut in its last words counts as heard (`PlayoutPace`, from the receipt's `playedMs`), so
 * a one-line terminal goodbye cut at 95% ends the call instead of being said again in full.
 *
 * N1: an ending the caller can still change (the LLM's `end_call`, a decision that did not end a
 * flow) is reopened by their next turn: the engine never ends the call while a caller turn is open,
 * and when that turn is answered `startTurn` takes the ending back. A final one (a flow's end, an
 * opt-out, a transfer) stays: the next turn says nothing and the call ends.
 *
 * Receipts are counted per playback epoch, never matched by text: the speaker's text filters (the
 * Indian verbalisation of an amount, say) change what a receipt reports having said.
 */
export class CallEnding {
  private epoch?: number;
  private unplayed = 0;
  private interrupted = false;
  private armed?: { reason: string; sealed: boolean; terminal?: boolean; final?: boolean };
  private ended?: string;
  /** The ending is final: a later caller turn cannot reopen it. */
  private endedFinal = false;
  private readonly pace = new PlayoutPace();
  /** The lines this turn has said, and how many of them have played to the end. */
  private turnLines: string[] = [];
  private turnHeard = 0;
  /** A terminal goodbye the caller barged in on, waiting for the next turn to `close`. */
  private cut?: { reason: string; lines: string[] };
  private replayed = false;

  /** Why the call ended, once it has. */
  get reason(): string | undefined {
    return this.ended;
  }

  get complete(): boolean {
    return this.ended !== undefined;
  }

  /** Receipts for any other playback epoch belong to an earlier turn. */
  beginTurn(epoch: number): void {
    this.epoch = epoch;
  }

  /**
   * A new reply starts: nothing it says has played, and it has not decided to end. One that answers
   * a caller who spoke after an ending the caller can change reopens the call (N1).
   */
  startTurn(): void {
    if (this.ended !== undefined && !this.endedFinal) this.ended = undefined;
    this.unplayed = 0;
    this.interrupted = false;
    this.armed = undefined;
    this.turnLines = [];
    this.turnHeard = 0;
  }

  said(text: string): void {
    this.unplayed += 1;
    this.turnLines.push(text);
  }

  /** `terminal`: the flow has ended with this turn (see the class comment). */
  arm(reason: string, options: { terminal?: boolean } = {}): void {
    if (this.ended === undefined && !this.interrupted)
      this.armed = { reason, sealed: false, ...(options.terminal ? { terminal: true } : {}) };
  }

  /** The turn has generated everything it will say. */
  seal(): void {
    if (!this.armed) return;
    this.armed.sealed = true;
    this.settle();
  }

  /**
   * P4: the flow has ended and this turn closes the call. Returns the lines to say first: the
   * goodbye the caller barged in on before any of it played, once; otherwise nothing. The call
   * ends when this turn's lines are out, played or cut. `reason` names the ending when no goodbye
   * was cut (the flow ended some other way).
   */
  close(reason: string): string[] {
    if (this.ended !== undefined) return [];
    const cut = this.cut;
    this.cut = undefined;
    const again = cut && !this.replayed ? cut.lines : [];
    if (again.length) this.replayed = true;
    this.armed = { reason: cut?.reason ?? reason, sealed: false, final: true };
    return again;
  }

  played(receipt: SpeechReceipt): void {
    this.pace.observe(receipt);
    if (this.epoch === undefined || receipt.epoch !== this.epoch || this.unplayed === 0) return;
    if (receipt.state === 'interrupted' && !this.armed?.final) {
      // A terminal goodbye cut in its last words was heard. Any other ending a barge-in disarms
      // however much played: the caller has something to say.
      if (this.armed?.terminal && this.pace.heard(receipt)) this.turnHeard += 1;
      this.keepCut();
      this.interrupted = true;
      this.armed = undefined;
      return;
    }
    if (receipt.state !== 'interrupted') this.turnHeard += 1;
    this.unplayed -= 1;
    this.settle();
  }

  /** The turn was cancelled (a barge-in, a newer turn). A final close is not undone by it. */
  cancel(): void {
    if (this.armed?.final) return;
    this.keepCut();
    this.armed = undefined;
  }

  /**
   * A terminal goodbye cut after one of its lines played has been heard: the call ends now, so the
   * engine can hang up on the receipt instead of waiting for the caller's next turn. One cut before
   * any of it played waits for `close` to say it once more.
   */
  private keepCut(): void {
    if (!this.armed?.terminal) return;
    if (this.turnHeard > 0) this.end(this.armed);
    else this.cut = { reason: this.armed.reason, lines: [...this.turnLines] };
  }

  private settle(): void {
    if (this.armed?.sealed && this.unplayed === 0) {
      this.end(this.armed);
      this.armed = undefined;
    }
  }

  private end(armed: { reason: string; terminal?: boolean; final?: boolean }): void {
    this.ended = armed.reason;
    this.endedFinal = Boolean(
      armed.terminal || armed.final || armed.reason.startsWith(TRANSFER_REASON_PREFIX),
    );
  }
}
