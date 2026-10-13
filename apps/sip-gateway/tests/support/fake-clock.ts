import type { GatewayClock } from '../../src/clock.ts';

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

/**
 * A manual GatewayClock (apps may not import the conformance kit's FakeClock, so this mirrors it).
 * Timers fire only from `advance`, in due-time then insertion order; `monotonic()` is `now()`.
 */
export class FakeClock implements GatewayClock {
  private current: number;
  private timers: Timer[] = [];
  private nextId = 0;

  constructor(start = 1_000_000) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  monotonic(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const timer = { id: this.nextId++, at: this.current + Math.max(0, ms), fn };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  }

  get pending(): number {
    return this.timers.length;
  }

  private nextDue(until: number): Timer | undefined {
    let best: Timer | undefined;
    for (const timer of this.timers)
      if (
        timer.at <= until &&
        (!best || timer.at < best.at || (timer.at === best.at && timer.id < best.id))
      )
        best = timer;
    return best;
  }

  /** Moves time forward, firing every timer due on the way (including ones scheduled meanwhile). */
  advance(ms: number): void {
    const target = this.current + ms;
    for (let timer = this.nextDue(target); timer; timer = this.nextDue(target)) {
      this.timers = this.timers.filter((t) => t !== timer);
      this.current = timer.at;
      timer.fn();
    }
    this.current = target;
  }

  /** Like `advance`, letting promise reactions settle after each timer. */
  async advanceAsync(ms: number): Promise<void> {
    const target = this.current + ms;
    await settle();
    for (let timer = this.nextDue(target); timer; timer = this.nextDue(target)) {
      this.timers = this.timers.filter((t) => t !== timer);
      this.current = timer.at;
      timer.fn();
      await settle();
    }
    this.current = target;
    await settle();
  }
}

export async function settle(turns = 3): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}
