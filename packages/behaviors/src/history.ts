import type { InferenceRequest, SpeechReceipt } from '@winsendotai/ovo-contracts';

type Message = NonNullable<InferenceRequest['history']>[number];

const EVIDENCE_NOTE = /^\[Playback evidence: [a-z-]+\.\] /;

/**
 * Told to the LLM, in its instructions, when the caller cut off the agent's previous reply. It was
 * once an assistant message in the history, and a model copied it into its reply, so the caller
 * heard "[The response was interrupted." (P7). Instructions are not something it says.
 */
export const INTERRUPTED_CONTEXT =
  'The caller cut off your previous reply, so they may not have heard any of it: do not assume ' +
  'they did. This is a note for you, never something to say.';

/** The words actually exchanged, without the playback evidence prefix this history adds. */
export function spokenHistory(history: readonly Message[]): Message[] {
  return history.map((entry) => ({ ...entry, content: entry.content.replace(EVIDENCE_NOTE, '') }));
}

/**
 * Bounded conversational evidence. Unplayed generated answers never enter memory, and a reply the
 * caller cut off leaves only the lines that played before it, plus `replyCut` for the next turn.
 */
export class PlaybackConversation {
  private entries: Message[] = [];
  private epoch?: number;
  private pending: { text: string; epoch: number }[] = [];
  /** A reply was cut since the caller last spoke, and whether the one before `user` was. */
  private cutSinceUser = false;
  private cut = false;
  constructor(private readonly budget = 4000) {}

  /** The caller cut off the agent's reply to their previous words (`INTERRUPTED_CONTEXT`). */
  get replyCut(): boolean {
    return this.cut;
  }

  beginTurn(epoch: number): void {
    if (
      !Number.isSafeInteger(epoch) ||
      epoch < 0 ||
      (this.epoch !== undefined && epoch <= this.epoch)
    )
      throw new Error('Conversation requires increasing playback epochs');
    if (this.pending.length) this.cutSinceUser = true;
    this.pending = [];
    this.epoch = epoch;
  }

  user(text: string): Message[] {
    const previous = this.entries.map((entry) => ({ ...entry }));
    this.cut = this.cutSinceUser;
    this.cutSinceUser = false;
    this.add({ role: 'user', content: text });
    return previous;
  }

  /**
   * AGT-10: the caller spoke again before hearing any answer to `text`, and the engine merged both
   * into the next turn. The superseded words leave the history (the merged turn records them again)
   * and its unplayed lines do not count as a cut reply: the caller never heard them start.
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
      this.cutSinceUser = true;
    } else {
      const prefix =
        receipt.evidence === 'confirmed' ? '' : `[Playback evidence: ${receipt.evidence}.] `;
      this.add({ role: 'assistant', content: prefix + receipt.text });
    }
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
