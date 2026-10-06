import type { InferenceRequest, SpeechReceipt } from '@winsendotai/ovo-contracts';

type Message = NonNullable<InferenceRequest['history']>[number];

const INTERRUPTED_NOTE =
  '[The response was interrupted. Do not assume any unconfirmed words were heard.]';
const EVIDENCE_NOTE = /^\[Playback evidence: [a-z-]+\.\] /;

/**
 * The words actually exchanged, without the notes this history adds for the LLM: the playback
 * evidence prefix is dropped and an interruption note, which was never said, is left out.
 */
export function spokenHistory(history: readonly Message[]): Message[] {
  return history
    .filter((entry) => entry.content !== INTERRUPTED_NOTE)
    .map((entry) => ({ ...entry, content: entry.content.replace(EVIDENCE_NOTE, '') }));
}

/** Bounded conversational evidence. Unplayed generated answers never enter memory. */
export class PlaybackConversation {
  private entries: Message[] = [];
  private epoch?: number;
  private pending: { text: string; epoch: number }[] = [];
  private interruptedEpochs = new Set<number>();
  constructor(private readonly budget = 4000) {}

  beginTurn(epoch: number): void {
    if (
      !Number.isSafeInteger(epoch) ||
      epoch < 0 ||
      (this.epoch !== undefined && epoch <= this.epoch)
    )
      throw new Error('Conversation requires increasing playback epochs');
    for (const pending of this.pending) this.recordInterrupted(pending.epoch);
    this.pending = [];
    this.epoch = epoch;
  }

  user(text: string): Message[] {
    const previous = this.entries.map((entry) => ({ ...entry }));
    this.add({ role: 'user', content: text });
    return previous;
  }

  /**
   * AGT-10: the caller spoke again before hearing any answer to `text`, and the engine merged both
   * into the next turn. The superseded words leave the history (the merged turn records them again)
   * and its unplayed lines leave no interruption note: the caller never heard them start.
   */
  withdraw(text: string): void {
    const index = this.entries.findLastIndex(
      (entry) => entry.role === 'user' && entry.content === text,
    );
    if (index >= 0) this.entries.splice(index, 1);
    this.pending = [];
  }

  generated(text: string): string {
    if (this.epoch !== undefined) this.pending.push({ text, epoch: this.epoch });
    return text;
  }

  played(receipt: SpeechReceipt): void {
    const index = this.pending.findIndex(
      (pending) => receipt.epoch === pending.epoch && receipt.text === pending.text,
    );
    if (index < 0) return;
    this.pending.splice(index, 1);
    if (receipt.state === 'interrupted') {
      this.recordInterrupted(receipt.epoch);
    } else {
      const prefix =
        receipt.evidence === 'confirmed' ? '' : `[Playback evidence: ${receipt.evidence}.] `;
      this.add({ role: 'assistant', content: prefix + receipt.text });
    }
  }

  private recordInterrupted(epoch: number): void {
    if (this.interruptedEpochs.has(epoch)) return;
    this.interruptedEpochs.add(epoch);
    if (this.interruptedEpochs.size > 20)
      this.interruptedEpochs.delete(this.interruptedEpochs.values().next().value!);
    this.add({ role: 'assistant', content: INTERRUPTED_NOTE });
  }

  private add(entry: Message): void {
    if ([...entry.content].length > this.budget) return;
    this.entries.push(entry);
    while (
      this.entries.length > 20 ||
      this.entries.reduce((sum, item) => sum + [...item.content].length, 0) > this.budget
    )
      this.entries.shift();
  }
}
