import type { Logger } from '@winsendotai/ovo-contracts';
import { optionalInteger } from './worker-environment.ts';

/**
 * OPS-6: on SIGTERM a worker used to end its active call at once, so every redeploy cut a caller
 * off. The drain stops new work (the caller already did), deregisters inbound capacity, then waits
 * up to OVO_WORKER_DRAIN_TIMEOUT_MS (default 240s, inside compose's 300s stop_grace_period) for
 * the active call to end by itself. Whatever is still running afterwards is terminated as before.
 */
export class ActiveCallDrain {
  private active = false;

  constructor(
    private readonly input: {
      log: Logger;
      sessionActive: () => boolean;
      describe: () => Record<string, unknown>;
      inbound?: { beginDrain(): Promise<void> };
      timeoutMs?: number;
      pollMs?: number;
    },
  ) {}

  /** True while a SIGTERM drain is waiting: the delivery loop keeps settling the active call. */
  get waiting(): boolean {
    return this.active;
  }

  /** Called by the loop when the active call can no longer be supervised (route missing). */
  abandon(): void {
    this.active = false;
  }

  async wait(): Promise<void> {
    const { log, sessionActive } = this.input;
    const timeoutMs =
      this.input.timeoutMs ??
      optionalInteger('OVO_WORKER_DRAIN_TIMEOUT_MS', 0, 3_600_000) ??
      240_000;
    this.active = true;
    try {
      await this.input.inbound?.beginDrain();
      if (!sessionActive()) return;
      const startedAt = Date.now();
      log.info('worker_drain_waiting', { ...this.input.describe(), timeoutMs });
      while (this.active && sessionActive() && Date.now() - startedAt < timeoutMs)
        await new Promise((resolve) => setTimeout(resolve, this.input.pollMs ?? 200));
      log[sessionActive() ? 'warn' : 'info']('worker_drain_finished', {
        waitedMs: Date.now() - startedAt,
        callEnded: !sessionActive(),
      });
    } finally {
      this.active = false;
    }
  }
}
