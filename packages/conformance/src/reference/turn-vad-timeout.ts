import type { Clock, TurnConfig } from '@winsendotai/ovo-contracts';

export interface VadTimeoutHooks {
  /** Whether the current turn already has text worth dispatching. */
  hasText(): boolean;
  /** End the turn with whatever has arrived. */
  finish(): void;
  /** Ask the provider to finalise now (`turn.reset` is not involved). */
  forceEndpoint(): void;
}

/**
 * The §2.7 vad-timeout strategy. 'auto' resolves to it whenever the host selected a VAD; the
 * provider's own end-of-turn is then not waited for. After the VAD reports silence the controller
 * waits `userSpeechTimeoutMs` for the transcript, then asks the provider to endpoint and gives it
 * `stopTimeoutMs` before ending the turn with whatever arrived.
 */
export class VadTimeout {
  private cancel?: () => void;
  /** True between the force-endpoint request and the final transcript it asked for. */
  forced = false;

  constructor(
    private readonly config: TurnConfig,
    private readonly clock: Clock,
    private readonly enabled: boolean,
    private readonly hooks: VadTimeoutHooks,
  ) {}

  /** Whether this strategy is in charge of ending speech turns. */
  get active(): boolean {
    const { strategy } = this.config;
    return strategy === 'vad-timeout' || (strategy === 'auto' && this.enabled);
  }

  stop(): void {
    this.cancel?.();
    this.cancel = undefined;
  }

  /** Speech resumed: nothing is pending any more. */
  onSpeech(): void {
    this.stop();
    this.forced = false;
  }

  onSilence(): void {
    if (!this.active) return;
    this.stop();
    this.cancel = this.clock.setTimeout(() => {
      this.cancel = undefined;
      if (this.hooks.hasText()) return this.hooks.finish();
      if (!this.config.waitForTranscript) return;
      this.forced = true;
      this.hooks.forceEndpoint();
      this.cancel = this.clock.setTimeout(() => {
        this.cancel = undefined;
        this.forced = false;
        this.hooks.finish();
      }, this.config.stopTimeoutMs);
    }, this.config.userSpeechTimeoutMs);
  }

  /** The finalisation we asked for arrived: end the turn without a provider end-of-turn. */
  onFinalTranscript(): boolean {
    if (!this.forced) return false;
    this.forced = false;
    this.stop();
    return true;
  }
}
