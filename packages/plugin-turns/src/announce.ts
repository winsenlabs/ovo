import {
  closesConversation,
  saysGoodbye,
  type TurnConfig,
  type TurnDecision,
} from '@winsendotai/ovo-contracts';

/**
 * What the detector tells the engine beyond turn boundaries: the utterance so far, for speculation
 * (LAT-4), and the filler line offered with each caller turn (LAT-6).
 */
export class TurnAnnouncer {
  /** The last turn.partial text, so an unchanged revision is not announced twice. */
  private announced = '';
  /** Whether it was announced stable. */
  private announcedStable = false;
  private fillers = 0;

  constructor(
    private readonly filler: TurnConfig['filler'],
    private readonly emit: (decision: TurnDecision) => void,
  ) {}

  /**
   * `view` is the utterance including interims; `final` its finalised part. Wave 10: words already
   * announced as an interim are announced again once final, so the LLM is asked on them then, not
   * after the revisable partial's debounce or at the end of the turn (call 10d5ef30 turns 9 and
   * 17: Scribe's last interim and its final said the same).
   */
  partial(turnId: string, view: string, final: string): void {
    const stable = view === final;
    if (!view || (view === this.announced && (this.announcedStable || !stable))) return;
    this.announced = view;
    this.announcedStable = stable;
    this.emit({ type: 'turn.partial', turnId, text: view, stable });
  }

  /**
   * The configured filler lines in rotation, one offered per caller turn that said `words`. Wave 9
   * (call 10d5ef30, D6): none for a goodbye or a closing ("Never mind. Thank you."), which is
   * answered with a goodbye: turn 22 played "One moment." 180 ms before its reply.
   */
  nextFiller(words: string): { text: string; afterMs: number } | undefined {
    if (!this.filler || saysGoodbye(words) || closesConversation(words)) return undefined;
    const lines = this.filler.lines;
    return { text: lines[this.fillers++ % lines.length]!, afterMs: this.filler.afterMs };
  }

  /** The turn closed: its next utterance is announced afresh. */
  clear(): void {
    this.announced = '';
    this.announcedStable = false;
  }
}
