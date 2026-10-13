import type { Clock, EndpointRule } from '@winsendotai/ovo-contracts';
import type { CommitConfig, DetectorConfig } from './config.ts';
import { WORDS_LAG_MS } from './noise-watch.ts';
import type { UtteranceEnd } from './utterance-end.ts';

/**
 * Wave 10: no final answers a host commit sooner than this. Scribe answered every commit of Maya
 * calls e8a43f65, 10d5ef30 and 4f1a919d in 286–444 ms (their replays, call-endpoints.ts); call
 * e8a43f65's turn 2 had a final 255 ms after the VAD stop, with no commit of its own.
 */
export const MIN_ANSWER_MS = 280;

/** The rules a commit fires under (see EndpointRule). */
export type CommitRule = Extract<
  EndpointRule,
  'complete' | 'silence' | 'long' | 'unfinished' | 'answer' | 'stall'
>;

/** How the caller's words so far read, for the commit's waits. */
export interface WordsView {
  view: string;
  ends: UtteranceEnd;
  /** An answer that ends the turn by itself ("Yes.", "हाँ।"), with no VAD speech going on. */
  answer: boolean;
}

/** Wave 10: the silence a VAD stop's early commit still owes the turn once the final is in. */
export interface Owed {
  /** The rest of the wait, from now. */
  ms: number;
  /**
   * The words at the stop trailed off or ran long with no end signal ('unfinished', 'long'): the
   * final waits the rest out even when it reads complete. Scribe closes the segment an early commit
   * cuts with a full stop ("…to Paris," → "…to Paris."), so its reading is no new signal; and a
   * final that says more than a stale interim did ("…a lot, so..." → "…so something like that.")
   * cannot tell a caller who finished from one who goes on after a pause (call 10d5ef30 turn 13).
   * The LLM is asked on the final as it lands, so the wait delays no reply that is asked ahead.
   */
  hold: boolean;
}

export interface CommitHooks {
  /** Time to force the endpoint (or, with the final already in, to end the turn). */
  due(rule: CommitRule): void;
  /** The final did not follow the commit within the ceiling. */
  ceiling(): void;
  /** How `view` reads now. */
  read(view: string): WordsView;
}

/**
 * The 'commit' strategy's timers (POC public/app.js endpoint()): a short local silence after a
 * real utterance commits, a ceiling bounds the wait for the provider's final once committed, and
 * an interim that stops changing commits even while the VAD still hears noise. Wave 8: both waits
 * follow how the words end (utterance-end.ts), so a complete sentence or answer is not held.
 */
export class CommitTimers {
  private cancelDue?: () => void;
  private cancelCeiling?: () => void;
  private cancelStall?: () => void;
  private cancelSettle?: () => void;
  /**
   * Wave 10 (commitAtStop): the wait a VAD stop's commit made early, timed from that stop, until
   * the final takes it (`takeOwed`).
   */
  private owed?: {
    stoppedAt: number;
    committedAt: number;
    waitMs: number;
    commitMs: number;
    hold: boolean;
  };
  private speechStartedAt?: number;
  /** When the VAD went quiet, until the commit: words that arrive meanwhile re-judge the wait. */
  private stoppedAt?: number;
  /** VAD speech in this utterance so far, across its runs. */
  private spokenMs = 0;
  private stalledText = '';
  /** When the interim last changed: the stall is timed from it, however often it is re-judged. */
  private stalledAt = 0;
  private readonly config: CommitConfig;
  private readonly ceilingMs: number;

  constructor(
    private readonly clock: Clock,
    config: Pick<DetectorConfig, 'commit' | 'userSpeechTimeoutMs'>,
    private readonly hooks: CommitHooks,
  ) {
    this.config = config.commit;
    // In 'commit' the speech timeout is a ceiling on the wait for the final, not an added wait.
    this.ceilingMs = config.userSpeechTimeoutMs;
  }

  speechStarted(): void {
    this.cancelDue?.();
    this.cancelCeiling?.();
    this.cancelSettle?.();
    this.cancelDue = this.cancelCeiling = this.cancelSettle = this.stoppedAt = undefined;
    this.owed = undefined;
    this.speechStartedAt ??= this.clock.now();
  }

  /**
   * A click or a breath shorter than minSpeechMs, with nothing transcribed, is not committed until
   * words for it arrive. The wait then follows how the interim `view` ends.
   */
  speechStopped(view: string): void {
    const now = this.clock.now();
    const spokeMs = now - (this.speechStartedAt ?? now);
    this.speechStartedAt = undefined;
    this.spokenMs += spokeMs;
    this.stoppedAt = now;
    if (!view && spokeMs < this.config.minSpeechMs) return;
    this.armDue(this.hooks.read(view));
  }

  /**
   * A changed interim: re-judges a commit still waiting out the VAD's silence ("I want to go to"
   * → "…to Paris."), or one a short VAD run left unarmed until its words came, and re-arms the
   * stall fallback. Words later than the STT's lag after the stop are new speech, not that run's.
   */
  interim(view: string): void {
    const words = this.hooks.read(view);
    if (this.cancelDue || this.clock.now() - (this.stoppedAt ?? -Infinity) <= WORDS_LAG_MS)
      this.armDue(words);
    if (view === this.stalledText) return;
    this.stalledText = view;
    this.stalledAt = this.clock.now();
    this.armStall(words);
  }

  /** The words now read differently (the agent stopped, the VAD went on or off): re-arms. */
  reread(): void {
    if (!this.cancelStall) return;
    this.armStall(this.hooks.read(this.stalledText));
  }

  /** The endpoint was forced; the final now has `ceilingMs` to arrive. */
  committed(): void {
    this.cancelDue?.();
    this.cancelStall?.();
    this.cancelCeiling?.();
    this.cancelDue = this.cancelStall = this.stoppedAt = undefined;
    this.cancelCeiling = this.clock.setTimeout(() => {
      this.cancelCeiling = undefined;
      this.hooks.ceiling();
    }, this.ceilingMs);
  }

  /**
   * Wave 10: the final is in. Takes the silence the stop's commit still owes the turn (undefined
   * unless it was made early under `commitAtStop`): the rest of the wait its words read at the
   * stop, which the turn waits out unless the final reads complete (see Owed.hold). A final that
   * answers the early commit ends the turn when the answer to the old commit would have come, and
   * one already in hand (`inHand`) when the old commit would have been made. A final in sooner
   * than Scribe answers a commit (`MIN_ANSWER_MS`) answered an earlier one, and ended the turn on
   * arrival then as now.
   */
  takeOwed(inHand: boolean): Owed | undefined {
    const owed = this.owed;
    this.owed = undefined;
    if (!owed) return undefined;
    const now = this.clock.now();
    const ms = inHand
      ? Math.max(0, owed.stoppedAt + owed.waitMs - now)
      : now - owed.committedAt < MIN_ANSWER_MS
        ? 0
        : owed.waitMs - owed.commitMs;
    return { ms, hold: owed.hold };
  }

  /** Wave 10: waits out `ms` the final owes; the final itself answered the commit's ceiling. */
  settle(ms: number, done: () => void): void {
    this.cancelCeiling?.();
    this.cancelSettle?.();
    this.cancelCeiling = undefined;
    this.cancelSettle = this.clock.setTimeout(() => {
      this.cancelSettle = undefined;
      done();
    }, ms);
  }

  cancel(): void {
    this.cancelDue?.();
    this.cancelCeiling?.();
    this.cancelStall?.();
    this.cancelSettle?.();
    this.cancelDue = this.cancelCeiling = this.cancelStall = this.cancelSettle = undefined;
    this.owed = undefined;
    this.speechStartedAt = this.stoppedAt = undefined;
    this.spokenMs = 0;
    this.stalledText = '';
  }

  /**
   * Complete words wait `completeSilenceMs` (never longer than silenceMs); words that trail off,
   * and long utterances whose end gives no signal, wait `longSilenceMs`; the rest `silenceMs`.
   * Timed from the VAD stop, so a re-judged wait never restarts it. Wave 10: with `commitAtStop`
   * every reading commits after the complete words' wait, and the rest of its own is owed to the
   * final, which ends the turn at once only if it reads complete.
   */
  private armDue(words: WordsView): void {
    const { silenceMs, completeSilenceMs, longSilenceMs, longUtteranceMs, commitAtStop } =
      this.config;
    const rule: CommitRule =
      words.ends === 'complete'
        ? 'complete'
        : words.ends === 'unfinished'
          ? 'unfinished'
          : this.spokenMs >= longUtteranceMs
            ? 'long'
            : 'silence';
    const completeMs = Math.min(silenceMs, completeSilenceMs);
    const waitMs =
      rule === 'complete'
        ? completeMs
        : rule === 'silence'
          ? silenceMs
          : Math.max(silenceMs, longSilenceMs);
    const commitMs = commitAtStop ? completeMs : waitMs;
    const stoppedAt = this.stoppedAt!;
    this.cancelDue?.();
    this.cancelDue = this.clock.setTimeout(
      () => {
        this.cancelDue = undefined;
        const committedAt = this.clock.now();
        const hold = rule === 'unfinished' || rule === 'long';
        this.owed = commitAtStop ? { stoppedAt, committedAt, waitMs, commitMs, hold } : undefined;
        this.hooks.due(rule);
      },
      Math.max(0, stoppedAt + commitMs - this.clock.now()),
    );
  }

  /** The stall: an answer by itself with no VAD speech going on commits after `answerStallMs`. */
  private armStall(words: WordsView): void {
    const { stallMs, answerStallMs } = this.config;
    const [ms, rule]: [number, CommitRule] =
      words.answer && answerStallMs ? [answerStallMs, 'answer'] : [stallMs, 'stall'];
    this.cancelStall?.();
    this.cancelStall = undefined;
    if (!ms) return;
    this.cancelStall = this.clock.setTimeout(
      () => {
        this.cancelStall = undefined;
        // A stalled interim commits with no silence behind it to owe.
        this.owed = undefined;
        this.hooks.due(rule);
      },
      Math.max(0, this.stalledAt + ms - this.clock.now()),
    );
  }
}
