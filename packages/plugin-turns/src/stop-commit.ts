import type { Clock, EndpointRule } from '@winsendotai/ovo-contracts';
import type { CommitConfig, DetectorConfig } from './config.ts';
import { WORDS_LAG_MS } from './noise-watch.ts';
import type { UtteranceEnd } from './utterance-end.ts';

/** The rules a commit fires under (see EndpointRule). */
export type CommitRule = Extract<
  EndpointRule,
  'complete' | 'silence' | 'long' | 'unfinished' | 'answer' | 'stall'
>;

/** How the caller's words so far read, for the commit's waits. */
export interface WordsView {
  view: string;
  ends: UtteranceEnd;
  /** A short complete answer ("Yes.", "हाँ।") that no VAD speech is timing. */
  answer: boolean;
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
    this.cancelDue = this.cancelCeiling = this.stoppedAt = undefined;
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

  cancel(): void {
    this.cancelDue?.();
    this.cancelCeiling?.();
    this.cancelStall?.();
    this.cancelDue = this.cancelCeiling = this.cancelStall = undefined;
    this.speechStartedAt = this.stoppedAt = undefined;
    this.spokenMs = 0;
    this.stalledText = '';
  }

  /**
   * Complete words wait `completeSilenceMs` (never longer than silenceMs); words that trail off,
   * and long utterances whose end gives no signal, wait `longSilenceMs`; the rest `silenceMs`.
   * Timed from the VAD stop, so a re-judged wait never restarts it.
   */
  private armDue(words: WordsView): void {
    const { silenceMs, completeSilenceMs, longSilenceMs, longUtteranceMs } = this.config;
    const rule: CommitRule =
      words.ends === 'complete'
        ? 'complete'
        : words.ends === 'unfinished'
          ? 'unfinished'
          : this.spokenMs >= longUtteranceMs
            ? 'long'
            : 'silence';
    const waitMs =
      rule === 'complete'
        ? Math.min(silenceMs, completeSilenceMs)
        : rule === 'silence'
          ? silenceMs
          : Math.max(silenceMs, longSilenceMs);
    this.cancelDue?.();
    this.cancelDue = this.clock.setTimeout(
      () => {
        this.cancelDue = undefined;
        this.hooks.due(rule);
      },
      Math.max(0, this.stoppedAt! + waitMs - this.clock.now()),
    );
  }

  /** The stall: a short complete answer no VAD is timing commits after `answerStallMs`. */
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
        this.hooks.due(rule);
      },
      Math.max(0, this.stalledAt + ms - this.clock.now()),
    );
  }
}
