import type { Clock } from '@winsendotai/ovo-contracts';

/** Wall time for timers and a monotonic reading for the media pacer (drift correction). */
export interface GatewayClock extends Clock {
  /** Monotonic milliseconds; `performance.now()` in production. */
  monotonic(): number;
}

export const systemClock: GatewayClock = Object.freeze({
  now: () => Date.now(),
  monotonic: () => performance.now(),
  setTimeout(fn: () => void, ms: number) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
});
