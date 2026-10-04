import type { Clock, TurnConfig, TurnDecision } from '@winsendotai/ovo-contracts';

export class IdleTimer {
  private cancelTimer?: () => void;
  private retries = 0;

  constructor(
    private readonly clock: Clock,
    private readonly config: TurnConfig['idle'],
    private readonly emit: (decision: TurnDecision) => void,
  ) {}

  cancel(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  arm(): void {
    this.cancel();
    if (!this.config) return;
    this.cancelTimer = this.clock.setTimeout(() => {
      this.cancelTimer = undefined;
      if (!this.config) return;
      if (this.retries >= this.config.maxRetries)
        this.emit({ type: 'idle', retry: this.retries, final: true });
      else {
        this.retries += 1;
        this.emit({
          type: 'idle',
          retry: this.retries,
          final: false,
          prompt: this.config.prompts[this.retries - 1],
        });
      }
    }, this.config.timeoutMs);
  }

  reset(): void {
    this.retries = 0;
    this.cancel();
  }
}
