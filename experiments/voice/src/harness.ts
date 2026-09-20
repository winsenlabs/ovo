import type { ScenarioResult, TraceEvent } from './contracts.ts';

export class TraceRecorder {
  readonly #started = performance.now();
  readonly #events: TraceEvent[] = [];

  add(type: string, details?: Record<string, unknown>): void {
    this.#events.push({
      sequence: this.#events.length + 1,
      type,
      elapsedMs: Number((performance.now() - this.#started).toFixed(3)),
      ...(details === undefined ? {} : { details }),
    });
  }

  snapshot(): TraceEvent[] {
    return structuredClone(this.#events);
  }
}

export class Deferred<T = void> {
  readonly promise: Promise<T>;
  #resolve!: (value: T | PromiseLike<T>) => void;
  #reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  resolve(value?: T): void {
    this.#resolve(value as T);
  }

  reject(reason: unknown): void {
    this.#reject(reason);
  }
}

export class TurnEpoch {
  #epoch = 1;
  readonly controller = new AbortController();

  capture(): number {
    return this.#epoch;
  }

  isCurrent(epoch: number): boolean {
    return epoch === this.#epoch;
  }

  interrupt(): void {
    this.#epoch += 1;
    this.controller.abort('caller takeover');
  }
}

export class ControlledOperationBoundary {
  readonly started = new Deferred<void>();
  readonly release = new Deferred<void>();
  attempts = 0;
  state: 'failed' | 'idle' | 'running' | 'succeeded' = 'idle';

  constructor(
    private readonly trace: TraceRecorder,
    private readonly epoch: TurnEpoch,
    private readonly acceptedEpoch: number,
  ) {}

  async execute(owner: Exclude<ScenarioResult['toolOwner'], 'none'>): Promise<string> {
    this.attempts += 1;
    if (this.attempts !== 1) throw new Error('operation boundary received a duplicate execution');

    this.trace.add('operation.intent.simulated-memory', { operationId: 'operation-1', owner });
    this.state = 'running';
    this.trace.add('operation.running.simulated-memory', { operationId: 'operation-1' });
    this.started.resolve();
    await this.release.promise;
    if (this.epoch.isCurrent(this.acceptedEpoch)) {
      this.state = 'succeeded';
      this.trace.add('operation.succeeded.simulated-memory', { operationId: 'operation-1' });
      this.trace.add('tool.result.current');
    } else {
      this.state = 'failed';
      this.trace.add('operation.failed.simulated-memory', { operationId: 'operation-1' });
      this.trace.add('tool.result.stale.blocked');
    }
    return 'balance:42';
  }
}

export async function settleWithin<T>(promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`scenario did not settle within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
