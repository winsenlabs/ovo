import type { Logger } from './log.ts';

/** Process counters behind `GET /health?verbose=1` (§18). Numbers only, never call data. */
export class Counters {
  readonly decisions: Record<string, number> = {};
  readonly endings: Record<string, number> = {};
  readonly drops: Record<string, number> = {};
  transactionTimeouts = 0;
  resumeAttempts = 0;
  resumeSuccesses = 0;
  jitterUnderruns = 0;
  pacerMaxDriftMs = 0;
  invites = 0;
  outboundDials = 0;

  bump(map: Record<string, number>, key: string, by = 1): void {
    map[key] = (map[key] ?? 0) + by;
  }
}

/**
 * Drop logging aggregated per source and reason every 10 s, so a scanner spraying the port costs
 * one log line, not one per packet.
 */
export class DropLog {
  private pending = new Map<string, { reason: string; source: string; count: number }>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly logger: Logger,
    private readonly counters: Counters,
  ) {}

  drop(reason: string, source: string): void {
    this.counters.bump(this.counters.drops, reason);
    const key = `${reason}|${source}`;
    const entry = this.pending.get(key);
    if (entry) entry.count += 1;
    else this.pending.set(key, { reason, source, count: 1 });
    this.timer ??= setTimeout(() => this.flush(), 10_000).unref();
  }

  flush(): void {
    this.timer = undefined;
    for (const entry of this.pending.values()) this.logger.warn('sip.drop', entry);
    this.pending.clear();
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.flush();
  }
}
