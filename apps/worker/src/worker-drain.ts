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
      /** The active outbound call's job, if any. */
      jobId: () => string | undefined;
      inbound?: { beginDrain(): Promise<void>; readonly hasActiveSession: boolean };
      timeoutMs?: number;
      pollMs?: number;
    },
  ) {}

  /**
   * True while a SIGTERM drain is waiting: the delivery loop keeps settling the active outbound
   * call, and the worker row stays leased as draining (the reporter stops only afterwards).
   */
  get waiting(): boolean {
    return this.active;
  }

  /** Called by the loop when the active call can no longer be supervised (route missing). */
  abandon(): void {
    this.active = false;
  }

  async wait(): Promise<void> {
    const { log, jobId, inbound } = this.input;
    const sessionActive = () => jobId() !== undefined || inbound?.hasActiveSession === true;
    const timeoutMs =
      this.input.timeoutMs ??
      optionalInteger('OVO_WORKER_DRAIN_TIMEOUT_MS', 0, 3_600_000) ??
      240_000;
    this.active = true;
    try {
      await this.input.inbound?.beginDrain();
      if (!sessionActive()) return;
      const startedAt = Date.now();
      log.info('worker_drain_waiting', {
        jobId: jobId(),
        inbound: inbound?.hasActiveSession ?? false,
        timeoutMs,
      });
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

/**
 * The shutdown steps for whatever the drain left running: the active outbound call is terminated
 * and its protection released, then inbound capacity closes. A failed step is reported and the
 * rest still run.
 */
export async function endRemainingWork(input: {
  active?: {
    jobId: string;
    lease: { ownerEpoch: number; stop(): void };
    protection: { release(): Promise<unknown> };
  };
  terminate: (jobId: string, ownerEpoch: number, reason: string) => Promise<unknown>;
  inbound?: { close(): Promise<void> };
  failed: (step: string, detail: string, error: unknown) => void;
}): Promise<void> {
  const { active, failed } = input;
  if (active) {
    try {
      await input.terminate(active.jobId, active.lease.ownerEpoch, 'worker-shutdown');
    } catch (error) {
      failed('outbound', 'outbound shutdown failed', error);
    }
    active.lease.stop();
    await active.protection
      .release()
      .catch((error) => failed('protection', 'protection release failed', error));
  }
  try {
    await input.inbound?.close();
  } catch (error) {
    failed('inbound', 'inbound shutdown failed', error);
  }
}
