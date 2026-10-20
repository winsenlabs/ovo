import type { MediaRoomProvider } from './human-contract.ts';

/** Five webhook failures within a minute open a queue's breaker for thirty seconds (design 7.4). */
export const BREAKER_FAILURES = 5;
export const BREAKER_WINDOW_MS = 60_000;
export const BREAKER_OPEN_MS = 30_000;
/** A room provider's health answer is trusted this long (design 7.2). */
export const ROOM_HEALTH_TTL_MS = 30_000;

/** A queue's circuit breaker: while open, its precheck says `queue_unavailable` and nothing is sent. */
export class HumanBreaker {
  private failures: number[] = [];
  private openUntil = 0;

  constructor(private readonly now: () => number) {}

  get open(): boolean {
    return this.now() < this.openUntil;
  }

  failure(): void {
    const at = this.now();
    this.failures = [...this.failures.filter((time) => at - time < BREAKER_WINDOW_MS), at];
    if (this.failures.length >= BREAKER_FAILURES) {
      this.openUntil = at + BREAKER_OPEN_MS;
      this.failures = [];
    }
  }

  success(): void {
    this.failures = [];
  }
}

/**
 * What the worker process shares between its calls' human queues: one breaker per queue and one
 * cached room-health answer, so a third party that is down or a room server that is unreachable is
 * found out once, not by every caller waiting on hold.
 */
export class HumanShared {
  private readonly breakers = new Map<string, HumanBreaker>();
  private health?: { at: number; ok: boolean };

  constructor(private readonly now: () => number = Date.now) {}

  breaker(queueId: string): HumanBreaker {
    let found = this.breakers.get(queueId);
    if (!found) this.breakers.set(queueId, (found = new HumanBreaker(this.now)));
    return found;
  }

  /** The room provider's cached health; a probe that throws or times out is unhealthy. */
  async roomHealthy(rooms: Pick<MediaRoomProvider, 'health'>): Promise<boolean> {
    if (this.health && this.now() - this.health.at < ROOM_HEALTH_TTL_MS) return this.health.ok;
    const ok = await rooms.health(AbortSignal.timeout(2_000)).then(
      (answer) => answer.ok,
      () => false,
    );
    this.health = { at: this.now(), ok };
    return ok;
  }
}
