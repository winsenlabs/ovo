import type { Clock } from '@winsendotai/ovo-contracts';

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

/** A manual Clock. Timers fire only from `advance`/`runAll`, in due-time then insertion order. */
export class FakeClock implements Clock {
  private current: number;
  private timers: Timer[] = [];
  private nextId = 0;

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const timer: Timer = { id: this.nextId++, at: this.current + Math.max(0, ms), fn };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  }

  get pendingTimers(): number {
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

  /** Like `advance`, but lets promise callbacks settle before and after each timer. */
  async advanceAsync(ms: number): Promise<void> {
    const target = this.current + ms;
    await flushMicrotasks();
    for (let timer = this.nextDue(target); timer; timer = this.nextDue(target)) {
      this.timers = this.timers.filter((t) => t !== timer);
      this.current = timer.at;
      timer.fn();
      await flushMicrotasks();
    }
    this.current = target;
    await flushMicrotasks();
  }

  /** Fires every pending timer (bounded, so a self-rescheduling timer cannot spin forever). */
  runAll(limit = 10_000): void {
    for (let i = 0; i < limit && this.timers.length; i += 1) {
      const timer = this.nextDue(Number.POSITIVE_INFINITY)!;
      this.timers = this.timers.filter((t) => t !== timer);
      this.current = Math.max(this.current, timer.at);
      timer.fn();
    }
  }
}

/** Lets queued promise reactions run (a few macrotask turns). */
export async function flushMicrotasks(turns = 3): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * A real clock whose delays are compressed by `scale` (0 → next macrotask) while `now()` reports
 * the uncompressed virtual time. Kits use it to replay long fixture scripts quickly.
 */
export function acceleratedClock(scale = 0): Clock {
  let virtual = Date.now();
  return {
    now: () => virtual,
    setTimeout(fn, ms) {
      const due = virtual + ms;
      const timer = setTimeout(
        () => {
          virtual = Math.max(virtual, due);
          fn();
        },
        Math.round(ms * scale),
      );
      return () => clearTimeout(timer);
    },
  };
}

export const realClock: Clock = Object.freeze({
  now: () => Date.now(),
  setTimeout(fn: () => void, ms: number) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
});
