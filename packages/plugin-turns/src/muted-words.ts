import type { TranscriptSegment } from '@winsendotai/ovo-contracts';
import type { TurnAggregator } from './aggregator.ts';

/**
 * Wave 12 (call 8cb76efc turn 6): words the STT gave while speech was muted (a disclosure, the
 * opening, a tool running) are dropped, but the STT's segment stays open until a commit. Live, the
 * caller spoke 1.5 s of Hindi over the opening; nothing committed it, so Scribe kept the segment
 * open and its final 7 s later began the caller's first turn with it ("हाँ, जी। हाँ, इस पर बात
 * करो। Hi, Maya. We are planning…"). Once that speech is over (`over`), a manual-commit STT is
 * committed and whatever it still says in those segments is dropped.
 */
export class MutedWords {
  /** Segments with words heard while muted and no final yet. */
  private readonly open = new Set<string>();

  /** `commit` commits the STT; unset (an STT that commits by itself), nothing is tracked. */
  constructor(
    private readonly aggregate: Pick<TurnAggregator, 'close'>,
    private readonly commit?: () => void,
  ) {}

  heard({ segmentId, stability }: Pick<TranscriptSegment, 'segmentId' | 'stability'>): void {
    if (!this.commit) return;
    if (stability === 'final') this.open.delete(segmentId);
    else this.open.add(segmentId);
  }

  /** The muted speech is over: its open segments are committed and closed. */
  over(): void {
    if (!this.open.size) return;
    for (const id of this.open) this.aggregate.close(id);
    this.open.clear();
    this.commit?.();
  }
}
