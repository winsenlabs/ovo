import type { DurableQueue, OutboxRecord, TaskProtection } from './types.ts';
import type { PostgresOrchestrationStore } from './postgres.ts';

export class OutboxPublisher {
  constructor(
    private readonly publisherId: string,
    private readonly store: PostgresOrchestrationStore,
    private readonly queue: DurableQueue,
  ) {}

  async flush(limit = 25): Promise<{ sent: number; failed: number }> {
    const records: OutboxRecord[] = await this.store.claimOutbox(this.publisherId, limit);
    let sent = 0;
    let failed = 0;
    for (const record of records) {
      try {
        await this.queue.send(record.payload);
        await this.store.markOutboxSent(record.id, this.publisherId);
        sent += 1;
      } catch (error) {
        failed += 1;
        await this.store.markOutboxFailed(
          record.id,
          this.publisherId,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return { sent, failed };
  }
}

export class ProtectionRenewal {
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private protectedUntilMs = 0;
  private retryMs = 5_000;
  private generation = 0;

  constructor(
    private readonly protection: TaskProtection,
    private readonly intervalMs: number,
    private readonly onRenewalFailure: () => void | Promise<void>,
    private readonly log: (event: { event: 'protection_renewal_failed'; remainingMs: number }) => void = console.error,
  ) {}

  async establish(): Promise<boolean> {
    if (this.stopped || !(await this.protection.establish())) return false;
    if (this.stopped) {
      await this.protection.release();
      return false;
    }
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.protectedUntilMs = Date.now() + 60 * 60_000;
    this.schedule(this.intervalMs);
    return true;
  }

  protectedUntil(): Date {
    return new Date(this.protectedUntilMs);
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => void this.renew(), delayMs);
    this.timer.unref();
  }

  private async renew(): Promise<void> {
    if (this.stopped) return;
    const generation = this.generation;
    let renewed = false;
    try {
      renewed = await this.protection.renew();
    } catch {
      // ECS transport failures use the same expiry budget as rejected renewals.
    }
    if (this.stopped || generation !== this.generation) return;
    if (renewed) {
      this.protectedUntilMs = Date.now() + 60 * 60_000;
      this.retryMs = 5_000;
      this.schedule(this.intervalMs);
      return;
    }
    const remainingMs = this.protectedUntilMs - Date.now();
    this.log({ event: 'protection_renewal_failed', remainingMs });
    if (remainingMs >= 5 * 60_000) {
      this.schedule(Math.min(this.retryMs, remainingMs - 5 * 60_000));
      this.retryMs = Math.min(this.retryMs * 2, this.intervalMs);
      return;
    }
    this.stopped = true;
    this.generation += 1;
    this.timer = undefined;
    await this.onRenewalFailure();
  }

  async release(): Promise<void> {
    if (this.stopped && !this.timer && this.protectedUntilMs === 0) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.protectedUntilMs = 0;
    await this.protection.release();
  }
}
