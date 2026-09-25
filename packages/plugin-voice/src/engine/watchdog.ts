import type { Clock } from '@winsendotai/ovo-contracts';

export function startWatchdog(clock: Clock, seconds: number, expire: () => void): () => void {
  if (!Number.isInteger(seconds) || seconds < 1) throw new RangeError('maxCallSeconds is invalid');
  return clock.setTimeout(expire, seconds * 1000);
}
