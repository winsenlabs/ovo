import type {
  DurableJobStore,
  DurableQueue,
  QueueDelivery,
} from '@winsendotai/ovo-plugin-orchestration';

export class JobLeaseRenewal {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly store: DurableJobStore,
    private readonly identity: { jobId: string; workerId: string; epoch: number },
    private readonly leaseMs: number,
    private readonly onFailure: () => void | Promise<void>,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), Math.max(1_000, Math.floor(this.leaseMs / 3)));
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    const renewed = await this.store
      .heartbeat(this.identity.jobId, this.identity.workerId, this.identity.epoch, this.leaseMs)
      .catch(() => false);
    if (renewed) return;
    this.stop();
    await this.onFailure();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export class DeliveryVisibilityRenewal {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly queue: DurableQueue,
    private readonly delivery: QueueDelivery,
    private readonly visibilitySeconds: number,
  ) {}

  start(): void {
    const intervalMs = Math.max(1_000, Math.floor((this.visibilitySeconds * 1_000) / 3));
    this.timer = setInterval(() => {
      void this.queue
        .changeVisibility(this.delivery, this.visibilitySeconds)
        .catch(() => undefined);
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
