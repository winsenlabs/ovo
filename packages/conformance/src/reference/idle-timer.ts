import type { Clock, TurnConfig } from '@winsendotai/ovo-contracts';

/**
 * The idle policy (§6.1 idle.ts): armed at bot.stopped when no turn is open and no tool runs;
 * `idle{retry, prompt}` repeats up to `maxRetries`, then `idle{final}` (→ caller_idle).
 */
export class IdleTimer {
  private cancel?: () => void;
  private retries = 0;

  constructor(
    private readonly config: TurnConfig['idle'],
    private readonly clock: Pick<Clock, 'setTimeout'>,
    private readonly busy: () => boolean,
    private readonly fire: (decision: { retry: number; final: boolean; prompt?: string }) => void,
  ) {}

  arm(): void {
    const idle = this.config;
    if (!idle || this.busy()) return;
    this.stop();
    this.cancel = this.clock.setTimeout(() => {
      this.cancel = undefined;
      if (this.busy()) return;
      this.retries += 1;
      const final = this.retries > idle.maxRetries;
      const prompt = final ? undefined : idle.prompts[(this.retries - 1) % idle.prompts.length];
      this.fire({ retry: this.retries, final, ...(prompt ? { prompt } : {}) });
    }, idle.timeoutMs);
  }

  stop(): void {
    this.cancel?.();
    this.cancel = undefined;
  }

  /** User activity resets the retry count. */
  reset(): void {
    this.stop();
    this.retries = 0;
  }
}
