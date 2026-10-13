import type { GatewayClock } from '../clock.ts';

/** More than this many late ticks are skipped rather than burst out (an event-loop stall). */
export const MAX_CATCHUP_TICKS = 5;

/**
 * A 20 ms media clock. Each tick is scheduled against `start + n × interval` on the monotonic
 * clock, so timer lateness never accumulates; after a stall it catches up a few ticks at once.
 */
export class Pacer {
  private start = 0;
  private ticks = 0;
  private emitted = 0;
  private cancel?: () => void;
  maxDriftMs = 0;
  skippedTicks = 0;

  constructor(
    private readonly clock: GatewayClock,
    private readonly onTick: () => void,
    private readonly intervalMs = 20,
  ) {}

  get running(): boolean {
    return this.cancel !== undefined;
  }

  /** Frames emitted since start; the upstream `tsMs` is `20 × count`. */
  get count(): number {
    return this.emitted;
  }

  begin(): void {
    if (this.cancel) return;
    this.start = this.clock.monotonic();
    this.ticks = 0;
    this.emitted = 0;
    this.schedule();
  }

  stop(): void {
    this.cancel?.();
    this.cancel = undefined;
  }

  private schedule(): void {
    const due = this.start + (this.ticks + 1) * this.intervalMs;
    this.cancel = this.clock.setTimeout(
      () => this.run(),
      Math.max(0, due - this.clock.monotonic()),
    );
  }

  private run(): void {
    const now = this.clock.monotonic();
    this.maxDriftMs = Math.max(
      this.maxDriftMs,
      now - (this.start + (this.ticks + 1) * this.intervalMs),
    );
    let due = Math.floor((now - this.start) / this.intervalMs) - this.ticks;
    if (due > MAX_CATCHUP_TICKS) {
      this.skippedTicks += due - MAX_CATCHUP_TICKS;
      this.ticks += due - MAX_CATCHUP_TICKS;
      due = MAX_CATCHUP_TICKS;
    }
    for (let i = 0; i < due && this.cancel; i += 1) {
      this.ticks += 1;
      this.emitted += 1;
      this.onTick();
    }
    if (this.cancel) this.schedule();
  }
}
