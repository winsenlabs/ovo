import type { SpeechReceipt } from '@winsendotai/ovo-contracts';

/**
 * The agent's own decision to end the call, held until the goodbye has actually played.
 *
 * A turn arms it (a decision outcome with `end`, or the LLM's `end_call`). The call is complete only
 * once that turn has finished generating and every line it said has a completed receipt, including
 * lines streamed before the model asked to end. An interrupted line disarms it: a caller who barges
 * in on the goodbye has something to say, so the call stays open for the next turn.
 *
 * A flow's ending is different (P4): the flow has reached a terminal node, and nothing the caller
 * says next can move it. Its goodbye is `terminal`; when the caller barges in on it, the next turn
 * `close`s the call, saying the goodbye once more only if no line of it was heard, and that close
 * is `final`: a barge-in no longer disarms it, and the call ends once its lines are out.
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
  /** The lines this turn has said, and how many of them have played to the end. */
  private turnLines: string[] = [];
  private turnHeard = 0;
  /** A terminal goodbye the caller barged in on, waiting for the next turn to `close`. */
  private cut?: { reason: string; lines: string[]; heard: boolean };
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

  /** A new reply starts: nothing it says has played, and it has not decided to end. */
  startTurn(): void {
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
   * goodbye the caller barged in on, once, when none of it was heard; otherwise nothing. The call
   * ends when this turn's lines are out, played or cut. `reason` names the ending when no goodbye
   * was cut (the flow ended some other way).
   */
  close(reason: string): string[] {
    if (this.ended !== undefined) return [];
    const cut = this.cut;
    this.cut = undefined;
    const again = cut && !cut.heard && !this.replayed ? cut.lines : [];
    if (again.length) this.replayed = true;
    this.armed = { reason: cut?.reason ?? reason, sealed: false, final: true };
    return again;
  }

  played(receipt: SpeechReceipt): void {
    if (this.epoch === undefined || receipt.epoch !== this.epoch || this.unplayed === 0) return;
    if (receipt.state === 'interrupted' && !this.armed?.final) {
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

  private keepCut(): void {
    if (this.armed?.terminal)
      this.cut = {
        reason: this.armed.reason,
        lines: [...this.turnLines],
        heard: this.turnHeard > 0,
      };
  }

  private settle(): void {
    if (this.armed?.sealed && this.unplayed === 0) {
      this.ended = this.armed.reason;
      this.armed = undefined;
    }
  }
}
