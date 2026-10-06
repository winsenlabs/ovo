import type { TurnConfig, TurnDecision } from '@winsendotai/ovo-contracts';

/**
 * What the detector tells the engine beyond turn boundaries: the utterance so far, for speculation
 * (LAT-4), and the filler line offered with each caller turn (LAT-6).
 */
export class TurnAnnouncer {
  /** The last turn.partial text, so an unchanged revision is not announced twice. */
  private announced = '';
  private fillers = 0;

  constructor(
    private readonly filler: TurnConfig['filler'],
    private readonly emit: (decision: TurnDecision) => void,
  ) {}

  /** `view` is the utterance including interims; `final` its finalised part. */
  partial(turnId: string, view: string, final: string): void {
    if (!view || view === this.announced) return;
    this.announced = view;
    this.emit({ type: 'turn.partial', turnId, text: view, stable: view === final });
  }

  /** The configured filler lines in rotation, one offered per caller turn. */
  nextFiller(): { text: string; afterMs: number } | undefined {
    if (!this.filler) return undefined;
    const lines = this.filler.lines;
    return { text: lines[this.fillers++ % lines.length]!, afterMs: this.filler.afterMs };
  }

  /** The turn closed: its next utterance is announced afresh. */
  clear(): void {
    this.announced = '';
  }
}
