import type { SpeechReceipt } from '@winsendotai/ovo-contracts';

/** At most this many lines wait for a receipt; older ones belong to turns long gone. */
const LIMIT = 32;

/**
 * P5: lines the caller must hear in full (a flow node's mandatory lines, the recording
 * disclosure), each matched to its playback receipt by epoch and text. Only a completed receipt
 * counts as heard: a line cut by a barge-in was not, however much of it played.
 */
export class MustHear {
  private pending: { epoch: number; text: string; id: string }[] = [];

  /** `text` is about to be spoken in playback epoch `epoch` and must be heard as `id`. */
  expect(epoch: number | undefined, id: string, text: string): void {
    if (epoch === undefined) return;
    this.pending.push({ epoch, text, id });
    if (this.pending.length > LIMIT) this.pending.shift();
  }

  /** The line this receipt settles, and whether the caller heard all of it. */
  played(receipt: SpeechReceipt): { id: string; heard: boolean } | undefined {
    const index = this.pending.findIndex(
      (line) => line.epoch === receipt.epoch && line.text === receipt.text,
    );
    if (index < 0) return undefined;
    const [line] = this.pending.splice(index, 1);
    return { id: line!.id, heard: receipt.state === 'completed' };
  }
}
