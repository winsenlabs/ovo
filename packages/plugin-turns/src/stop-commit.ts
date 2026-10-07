import type { Clock } from '@winsendotai/ovo-contracts';
import type { CommitConfig, DetectorConfig } from './config.ts';
import { endsCutOff } from './transcript-text.ts';

export interface CommitHooks {
  /** Time to force the endpoint (or, with the final already in, to end the turn). */
  due(): void;
  /** The final did not follow the commit within the ceiling. */
  ceiling(): void;
}

/**
 * The 'commit' strategy's timers (POC public/app.js endpoint()): a short local silence after a
 * real utterance commits, a ceiling bounds the wait for the provider's final once committed, and
 * an interim that stops changing commits even while the VAD still hears noise.
 */
export class CommitTimers {
  private cancelDue?: () => void;
  private cancelCeiling?: () => void;
  private cancelStall?: () => void;
  private speechStartedAt?: number;
  /** VAD speech in this utterance so far, across its runs. */
  private spokenMs = 0;
  private stalledText = '';
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
    this.cancelDue = this.cancelCeiling = undefined;
    this.speechStartedAt ??= this.clock.now();
  }

  /**
   * A click or a breath shorter than minSpeechMs, with nothing transcribed, is not committed. A
   * long utterance, or one whose interim `view` broke off mid-word, waits `longSilenceMs`.
   */
  speechStopped(view: string): void {
    const spokeMs = this.clock.now() - (this.speechStartedAt ?? this.clock.now());
    this.speechStartedAt = undefined;
    this.spokenMs += spokeMs;
    if (!view && spokeMs < this.config.minSpeechMs) return;
    const long = this.spokenMs >= this.config.longUtteranceMs || endsCutOff(view);
    this.cancelDue?.();
    this.cancelDue = this.clock.setTimeout(
      () => {
        this.cancelDue = undefined;
        this.hooks.due();
      },
      long ? Math.max(this.config.silenceMs, this.config.longSilenceMs) : this.config.silenceMs,
    );
  }

  /** Re-arms the stall fallback whenever the interim view changes. */
  interim(view: string): void {
    if (!this.config.stallMs || view === this.stalledText) return;
    this.stalledText = view;
    this.cancelStall?.();
    this.cancelStall = this.clock.setTimeout(() => {
      this.cancelStall = undefined;
      this.hooks.due();
    }, this.config.stallMs);
  }

  /** The endpoint was forced; the final now has `ceilingMs` to arrive. */
  committed(): void {
    this.cancelStall?.();
    this.cancelCeiling?.();
    this.cancelStall = undefined;
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
    this.speechStartedAt = undefined;
    this.spokenMs = 0;
    this.stalledText = '';
  }
}
