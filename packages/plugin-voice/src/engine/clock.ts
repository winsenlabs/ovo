import type { Clock } from '@winsendotai/ovo-contracts';

export const realClock: Clock = {
  now: Date.now,
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};
