import type { Clock } from '@winsendotai/ovo-contracts';
import type { BoundedSpeechScheduler } from '../scheduler.ts';
import type { ReplyAudibility } from './turn-audibility.ts';
import type { Turn } from './turn-book.ts';

/**
 * LAT-6: a caller turn whose reply has made no sound `afterMs` into the turn plays its filler line
 * (a fixed line, so a pre-rendered clip), at most once for the caller's words. A fast reply (the
 * rules tier, a quick decision) produces its first line first, and the caller cancels the timer.
 * The filler is never handed to the behaviour: it is not part of the conversation it records. Its
 * speaking interval is announced as a filler (`bot.started.filler`), so the caller's words over it
 * are taken as in silence rather than as backchannels (AGT-9).
 */
export class TurnFiller {
  constructor(
    private readonly clock: Pick<Clock, 'setTimeout'>,
    private readonly speech: BoundedSpeechScheduler,
    private readonly audibility: ReplyAudibility,
    /** False once the call is ending. */
    private readonly live: () => boolean,
    private readonly failed: (turnId: string, error: unknown) => void,
  ) {}

  /** Returns the cancel for the turn's filler timer, if it has one to play. */
  arm(turn: Turn, epoch: number): (() => void) | undefined {
    const { speech, audibility } = this;
    const filler = turn.filler;
    if (!filler || turn.fillerPlayed) return undefined;
    return this.clock.setTimeout(() => {
      if (!this.live() || turn.controller?.signal.aborted) return;
      if (epoch !== speech.epoch || audibility.answered(epoch)) return;
      turn.fillerPlayed = true;
      const receipt = audibility.filler(() =>
        speech.speak(filler.text, { epoch, kind: 'acknowledgment' }),
      );
      void receipt.catch((error: unknown) => this.failed(turn.id, error));
    }, filler.afterMs);
  }
}
