import type { Clock } from '@winsendotai/ovo-contracts';
import type { InferenceActivity } from '@winsendotai/ovo-plugin-kit';
import type { BoundedSpeechScheduler } from '../scheduler.ts';
import type { ReplyAudibility } from './turn-audibility.ts';
import type { Turn } from './turn-book.ts';

/** The reply a filler may still play for: armed, and not yet answered or cancelled. */
interface Armed {
  turn: Turn;
  epoch: number;
  searchAnnounced: boolean;
  timers: (() => void)[];
}

/**
 * LAT-6: a caller turn whose reply has made no sound `afterMs` into the turn plays its filler line
 * (a fixed line, so a pre-rendered clip), at most once for the caller's words. A fast reply (the
 * rules tier, a quick decision) produces its first line first, and the caller cancels the timer;
 * a reply whose first line is ready while the filler still plays cuts it (P3, TurnDriver.preempt),
 * and no filler starts while the caller is speaking again (P1).
 * N3: when the provider starts a web search for the reply (`activity`), its search line plays at
 * once in place of a generic filler not yet due, and its "still checking" line once
 * `stillAfterMs` pass with no reply line. Only a turn that searches hears them.
 * The filler is never handed to the behaviour: it is not part of the conversation it records. Its
 * speaking interval is announced as a filler (`bot.started.filler`), so the caller's words over it
 * are taken as in silence rather than as backchannels (AGT-9).
 */
export class TurnFiller {
  private armed?: Armed;

  constructor(
    private readonly clock: Pick<Clock, 'setTimeout'>,
    private readonly speech: BoundedSpeechScheduler,
    private readonly audibility: ReplyAudibility,
    /** False once the call is ending. */
    private readonly live: () => boolean,
    private readonly failed: (turnId: string, error: unknown) => void,
  ) {}

  /**
   * The turn's reply is being composed in `epoch`. Returns the cancel to call once its first line
   * is ready or it ends: it stops the filler timer and any search line still to come.
   */
  arm(turn: Turn, epoch: number): () => void {
    const armed: Armed = { turn, epoch, searchAnnounced: false, timers: [] };
    this.armed = armed;
    const filler = turn.filler;
    if (filler && !turn.fillerPlayed)
      armed.timers.push(
        this.clock.setTimeout(() => {
          if (!this.speakable(armed)) return;
          turn.fillerPlayed = true;
          this.play(armed, filler.text);
        }, filler.afterMs),
      );
    return () => {
      for (const cancel of armed.timers.splice(0)) cancel();
      if (this.armed === armed) this.armed = undefined;
    };
  }

  /** A provider tool's progress (N3): a search started for the reply being composed. */
  activity(activity: InferenceActivity): void {
    const armed = this.armed;
    if (activity.phase !== 'started' || !activity.announce || activity.signal.aborted) return;
    if (!armed || armed.searchAnnounced || !this.speakable(armed)) return;
    armed.searchAnnounced = true;
    const { line, stillLine, stillAfterMs } = activity.announce;
    const { turn } = armed;
    // The search line says more than a generic filler: it replaces one not yet due.
    for (const cancel of armed.timers.splice(0)) cancel();
    if (line && !(turn.fillerPlayed && turn.filler?.text === line)) {
      turn.fillerPlayed = true;
      this.play(armed, line);
    }
    if (stillLine)
      armed.timers.push(
        this.clock.setTimeout(() => {
          if (this.speakable(armed)) this.play(armed, stillLine);
        }, stillAfterMs),
      );
  }

  /** The reply has made no sound, the caller is not speaking, and nothing cancelled it. */
  private speakable({ turn, epoch }: Armed): boolean {
    if (!this.live() || turn.controller?.signal.aborted) return false;
    if (epoch !== this.speech.epoch || this.audibility.answered(epoch)) return false;
    // P1: the caller is speaking again; a filler now would talk over them.
    return !this.speech.held;
  }

  private play({ turn, epoch }: Armed, text: string): void {
    const receipt = this.audibility.filler(() =>
      this.speech.speak(text, { epoch, kind: 'acknowledgment' }),
    );
    void receipt.catch((error: unknown) => this.failed(turn.id, error));
  }
}
