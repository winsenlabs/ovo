import type {
  Behavior,
  MediaDuplex,
  SessionInput,
  SpeechReceipt,
} from '@winsendotai/ovo-contracts';

/**
 * Hands each spoken line's playback receipt to the behaviour, and lets a turn wait until every
 * receipt has been delivered, so the behaviour's completion check sees every line played.
 */
export class SpeechReceipts {
  private readonly pending = new Set<Promise<void>>();
  /** P3: a reply moved to a fresh epoch keeps reporting under the epoch its behaviour began. */
  private readonly aliases = new Map<number, number>();

  constructor(
    private readonly behavior: Behavior,
    private readonly media: MediaDuplex,
    private readonly session: SessionInput,
    /** A receipt or its delivery failed; called before the pending entry is removed. */
    private readonly failed: (error: unknown) => void,
  ) {}

  /** Receipts for `epoch` reach the behaviour as `as`, the epoch its turn began with. */
  alias(epoch: number, as: number): void {
    this.aliases.set(epoch, this.aliases.get(as) ?? as);
    for (const key of this.aliases.keys()) if (key < epoch - 8) this.aliases.delete(key);
  }

  /** `said`: the behaviour's own line. The receipt carries the filtered text, which it can't match. */
  track(receipt: Promise<SpeechReceipt>, said?: string): void {
    let delivery!: Promise<void>;
    delivery = receipt
      .then((value) =>
        this.behavior.onPlayback?.({
          ...value,
          ...(said === undefined ? {} : { text: said }),
          ...(this.aliases.has(value.epoch) ? { epoch: this.aliases.get(value.epoch)! } : {}),
          ...(value.evidence === 'confirmed' &&
          this.media.playbackEvidence === 'carrier-processed' &&
          this.session.acknowledgements.includes('weak-playback-evidence')
            ? { evidenceSource: 'carrier-processed' as const }
            : {}),
        }),
      )
      .then(() => undefined)
      // Receipt failures can arrive while respondStream is still awaiting its next item. Observe
      // them immediately, before removing the pending entry.
      .catch((error: unknown) => this.failed(error))
      .finally(() => this.pending.delete(delivery));
    this.pending.add(delivery);
  }

  async deliver(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  /** Every delivery still in flight, for disposal to settle. */
  inFlight(): Promise<void>[] {
    return [...this.pending];
  }
}
