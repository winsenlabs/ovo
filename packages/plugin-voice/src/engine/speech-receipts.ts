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

  constructor(
    private readonly behavior: Behavior,
    private readonly media: MediaDuplex,
    private readonly session: SessionInput,
    /** A receipt or its delivery failed; called before the pending entry is removed. */
    private readonly failed: (error: unknown) => void,
  ) {}

  /** `said`: the behaviour's own line. The receipt carries the filtered text, which it can't match. */
  track(receipt: Promise<SpeechReceipt>, said?: string): void {
    let delivery!: Promise<void>;
    delivery = receipt
      .then((value) =>
        this.behavior.onPlayback?.({
          ...value,
          ...(said === undefined ? {} : { text: said }),
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
