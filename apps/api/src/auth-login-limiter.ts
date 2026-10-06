/**
 * OPS-15: per-account sign-in lockout. The per-IP throttle alone lets a guessing run rotate source
 * addresses against one administrator email, so failed passwords are also counted per account:
 * after `maxFailures` within `windowMs`, the account refuses sign-in for `lockMs`, and a correct
 * password inside the lock is refused too. A success clears the count. Bounded, in-process state:
 * several API replicas need a shared edge limit as well.
 */
export class LoginLockout {
  private readonly entries = new Map<string, { failures: number[]; lockedUntil: number }>();

  constructor(
    private readonly options: {
      maxFailures: number;
      windowMs: number;
      lockMs: number;
      maxEntries?: number;
      now?: () => number;
    } = { maxFailures: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000 },
  ) {}

  /** Seconds until the account may try again, or 0 when it may now. */
  retryAfterSeconds(key: string): number {
    const entry = this.entries.get(key);
    const now = this.now();
    if (!entry || entry.lockedUntil <= now) return 0;
    return Math.ceil((entry.lockedUntil - now) / 1000);
  }

  failed(key: string): void {
    const now = this.now();
    this.prune(now);
    let entry = this.entries.get(key);
    if (!entry) {
      // Under a flood of distinct keys, the oldest entry makes room: memory stays bounded.
      if (this.entries.size >= (this.options.maxEntries ?? 10_000))
        this.entries.delete(this.entries.keys().next().value!);
      entry = { failures: [], lockedUntil: 0 };
      this.entries.set(key, entry);
    }
    entry.failures = [...entry.failures.filter((at) => at > now - this.options.windowMs), now];
    if (entry.failures.length >= this.options.maxFailures) {
      entry.lockedUntil = now + this.options.lockMs;
      entry.failures = [];
    }
  }

  succeeded(key: string): void {
    this.entries.delete(key);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries)
      if (
        entry.lockedUntil <= now &&
        entry.failures.every((at) => at <= now - this.options.windowMs)
      )
        this.entries.delete(key);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
