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

  constructor(
    private readonly protection: TaskProtection,
    private readonly intervalMs: number,
    private readonly onRenewalFailure: () => void | Promise<void>,
  ) {}

  async establish(): Promise<boolean> {
    if (this.stopped || !(await this.protection.establish())) return false;
    this.timer = setInterval(() => void this.renew(), this.intervalMs);
    this.timer.unref();
    return true;
  }

  private async renew(): Promise<void> {
    if (this.stopped) return;
    if (await this.protection.renew()) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.onRenewalFailure();
  }

  async release(): Promise<void> {
    if (this.stopped && !this.timer) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.protection.release();
  }
}
