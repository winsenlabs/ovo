import type { PostgresOrchestrationStore } from '@winsendotai/ovo-plugin-orchestration';
import { WorkerInfrastructureMetrics } from './infrastructure-metrics.ts';

type WorkerState = 'starting' | 'dial-disabled' | 'ready' | 'active' | 'draining' | 'failed';

export class WorkerReporter {
  private readonly metrics = new WorkerInfrastructureMetrics();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly input: {
      store: PostgresOrchestrationStore;
      workerId: string;
      ownershipEpoch: number;
      state: () => WorkerState;
      onFailure: (error: unknown) => void;
    },
  ) {}

  async start(): Promise<void> {
    await this.report();
    this.timer = setInterval(() => void this.report().catch(this.input.onFailure), 5_000);
    this.timer.unref();
  }

  async reportReserved(): Promise<void> {
    await this.input.store.reportWorker({
      workerId: this.input.workerId,
      state: 'reserved',
      ownershipEpoch: this.input.ownershipEpoch,
      leaseMs: 15_000,
      metadata: this.metadata(),
    });
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.report().catch(() => undefined);
    this.metrics.close();
  }

  async report(): Promise<void> {
    const state = this.input.state();
    await this.input.store.reportWorker({
      workerId: this.input.workerId,
      ownershipEpoch: this.input.ownershipEpoch,
      leaseMs: 15_000,
      state: state === 'active' ? 'active' : state === 'draining' ? 'draining' : 'ready_idle',
      metadata: this.metadata(),
    });
  }

  private metadata() {
    return { liveDial: true, infrastructure: this.metrics.snapshot() };
  }
}
