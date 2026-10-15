import type { DisclosureKind, SpeechReceipt } from '@winsendotai/ovo-contracts';
import type { RouteRecorder } from './events.ts';

export type DisclosurePart = { kind: DisclosureKind; text: string };

const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * The router release's disclosure on a call that can hand on with transfers (R2 §7.10): the parts
 * the caller has not heard yet this call (a re-routed router skips what an earlier segment said),
 * said once before the greeting, and recorded as a `disclosure` event when the caller heard all of
 * it, so later segments do not say those kinds again. A disclosure cut by a barge-in is not
 * recorded: the agent that takes the call says it.
 */
export class RouterDisclosure {
  readonly text: string;
  readonly kinds: DisclosureKind[];
  private state: 'due' | 'said' | 'settled' = 'due';
  private epoch?: number;
  private heardText = '';

  private constructor(
    parts: readonly DisclosurePart[],
    private readonly recorder: RouteRecorder,
  ) {
    this.kinds = parts.map((part) => part.kind);
    this.text = flat(parts.map((part) => part.text).join(' '));
  }

  /** Undefined when nothing is left to disclose. */
  static of(
    parts: readonly DisclosurePart[] | undefined,
    heard: readonly DisclosureKind[],
    recorder: RouteRecorder,
  ): RouterDisclosure | undefined {
    const unheard = (parts ?? []).filter((part) => !heard.includes(part.kind));
    return unheard.length ? new RouterDisclosure(unheard, recorder) : undefined;
  }

  /** `line` with the disclosure before it, the first time only. */
  before(line: string): string {
    if (this.state !== 'due') return line;
    this.state = 'said';
    return line ? `${this.text} ${line}` : this.text;
  }

  /** The line it was said in plays in playback epoch `epoch` (the turn's `beginTurn`). */
  bind(epoch: number | undefined): void {
    if (this.state === 'said' && this.epoch === undefined) this.epoch = epoch;
  }

  /**
   * A receipt of the line it was said in: heard once completed receipts of that epoch cover it,
   * in order; any interrupted receipt before then means the caller did not hear all of it.
   */
  played(receipt: SpeechReceipt): void {
    if (this.state !== 'said' || this.epoch === undefined || receipt.epoch !== this.epoch) return;
    if (receipt.state !== 'completed') {
      this.state = 'settled';
      return;
    }
    this.heardText = flat(`${this.heardText} ${receipt.text}`);
    if (!this.heardText.startsWith(this.text)) return;
    this.state = 'settled';
    this.recorder.disclosure({ kinds: this.kinds });
  }
}
