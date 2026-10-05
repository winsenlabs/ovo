import {
  computeCapacitySignal,
  type CapacitySignalInput,
} from '@winsendotai/ovo-plugin-orchestration';
import type { InboundReadiness } from './dispatcher-capacity.ts';

export interface DispatcherTask {
  id: string;
  intervalMs: number;
  jitterMs?: number;
  tick(signal: AbortSignal): Promise<void>;
}

type Signal = NonNullable<ReturnType<typeof computeCapacitySignal>>;

export class DispatcherLoop {
  private readonly abort = new AbortController();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly running = new Set<Promise<void>>();
  private started = false;
  private status = { healthy: false, detail: 'initializing' };
  private lastSignal?: Signal;
  private inbound?: InboundReadiness;

  constructor(
    private readonly input: {
      tasks: readonly DispatcherTask[];
      readCapacityInput(): Promise<CapacitySignalInput>;
      publish(signal: Signal): Promise<void>;
      readInboundReadiness?(capacity: CapacitySignalInput): Promise<InboundReadiness>;
      log?: (entry: Record<string, unknown>) => void;
      random?: () => number;
    },
  ) {}

  health(): {
    healthy: boolean;
    detail: string;
    lastCapacity?: Signal;
    inbound?: InboundReadiness;
  } {
    return { ...this.status, lastCapacity: this.lastSignal, inbound: this.inbound };
  }

  /** Readiness is reported, never enforced here; a failure must not stop capacity signals. */
  private async refreshInbound(capacity: CapacitySignalInput): Promise<void> {
    if (!this.input.readInboundReadiness) return;
    try {
      const next = await this.input.readInboundReadiness(capacity);
      if (JSON.stringify(next) !== JSON.stringify(this.inbound))
        this.input.log?.({ event: 'inbound_readiness', ...next });
      this.inbound = next;
    } catch (error) {
      this.inbound = undefined;
      this.input.log?.({ event: 'inbound_readiness_failed', error: String(error) });
    }
  }

  async capacityTick(): Promise<void> {
    if (this.abort.signal.aborted) return;
    try {
      const input = await this.input.readCapacityInput();
      if (this.abort.signal.aborted) return;
      await this.refreshInbound(input);
      const signal = computeCapacitySignal(input);
      if (!signal) {
        this.status = { healthy: false, detail: 'capacity input stale or inconsistent' };
        return;
      }
      await this.input.publish(signal);
      this.lastSignal = signal;
      this.status = { healthy: true, detail: 'dispatcher loops healthy' };
    } catch (error) {
      this.status = { healthy: false, detail: `capacity:${String(error)}` };
      this.input.log?.({ event: 'capacity_signal_failed', error: String(error) });
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.schedule(0, () => this.capacityTick(), 10_000);
    for (const task of this.input.tasks) {
      if (!Number.isSafeInteger(task.intervalMs) || task.intervalMs < 1)
        throw new Error(`Invalid interval for background task ${task.id}`);
      const jitter = this.jitter(task.jitterMs ?? 0);
      this.schedule(jitter, () => task.tick(this.abort.signal), task.intervalMs, task);
    }
  }

  async stop(): Promise<void> {
    this.abort.abort();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled(this.running);
    this.status = { healthy: false, detail: 'draining' };
  }

  private jitter(maxMs: number): number {
    if (!Number.isSafeInteger(maxMs) || maxMs < 0) throw new Error('Invalid task jitter');
    return Math.floor((this.input.random?.() ?? Math.random()) * (maxMs + 1));
  }

  private schedule(
    delayMs: number,
    tick: () => Promise<void>,
    intervalMs: number,
    task?: DispatcherTask,
  ): void {
    if (this.abort.signal.aborted) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      const running = (async () => {
        try {
          await tick();
        } catch (error) {
          this.input.log?.({
            event: 'background_task_failed',
            taskId: task?.id,
            error: String(error),
          });
        } finally {
          if (!this.abort.signal.aborted)
            this.schedule(intervalMs + this.jitter(task?.jitterMs ?? 0), tick, intervalMs, task);
        }
      })();
      this.running.add(running);
      void running.finally(() => this.running.delete(running));
    }, delayMs);
    timer.unref();
    this.timers.add(timer);
  }
}
