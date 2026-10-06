import type { SpeechReceipt } from '@winsendotai/ovo-contracts';

/**
 * The agent's own decision to end the call, held until the goodbye has actually played.
 *
 * A turn arms it (a decision outcome with `end`, or the LLM's `end_call`). The call is complete only
 * once that turn has finished generating and every line it said has a completed receipt, including
 * lines streamed before the model asked to end. An interrupted line disarms it: a caller who barges
 * in on the goodbye has something to say, so the call stays open for the next turn.
 *
 * Receipts are counted per playback epoch, never matched by text: the speaker's text filters (the
 * Indian verbalisation of an amount, say) change what a receipt reports having said.
 */
export class CallEnding {
  private epoch?: number;
  private unplayed = 0;
  private interrupted = false;
  private armed?: { reason: string; sealed: boolean };
  private ended?: string;

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
  }

  said(): void {
    this.unplayed += 1;
  }

  arm(reason: string): void {
    if (this.ended === undefined && !this.interrupted) this.armed = { reason, sealed: false };
  }

  /** The turn has generated everything it will say. */
  seal(): void {
    if (!this.armed) return;
    this.armed.sealed = true;
    this.settle();
  }

  played(receipt: SpeechReceipt): void {
    if (this.epoch === undefined || receipt.epoch !== this.epoch || this.unplayed === 0) return;
    if (receipt.state === 'interrupted') {
      this.interrupted = true;
      this.armed = undefined;
      return;
    }
    this.unplayed -= 1;
    this.settle();
  }

  cancel(): void {
    this.armed = undefined;
  }

  private settle(): void {
    if (this.armed?.sealed && this.unplayed === 0) {
      this.ended = this.armed.reason;
      this.armed = undefined;
    }
  }
}
