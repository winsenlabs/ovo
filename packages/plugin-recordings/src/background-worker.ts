import { randomUUID } from 'node:crypto';
import type { RecordingExportService } from './exports.ts';
import type { RecordingRetentionService } from './retention.ts';
import type { ExportRedactionPolicy, RetentionCursor } from './types.ts';

export interface RecordingBackgroundWorkerConfig {
  pollIntervalMs?: number;
  exportLeaseMs?: number;
  exportTimeoutMs?: number;
  exportClaimLimit?: number;
  exportPolicy?: ExportRedactionPolicy;
  retentionIntervalMs?: number;
  retentionLimit?: number;
  onError?: (event: RecordingBackgroundWorkerError) => void;
}

export interface RecordingBackgroundWorkerError {
  operation: 'exports' | 'retention-sweep';
  errorType: string;
}

export interface RecordingBackgroundWorkerResult {
  ran: boolean;
  exports?: { claimed: number; succeeded: number; failed: number };
  swept?: number;
  cleaned?: number;
  cleanupFailed?: number;
}

export class RecordingBackgroundWorker {
  private readonly options: Required<
    Omit<RecordingBackgroundWorkerConfig, 'exportPolicy' | 'onError'>
  > &
    Pick<RecordingBackgroundWorkerConfig, 'exportPolicy' | 'onError'>;
  private readonly owner = `recordings-${process.pid}-${randomUUID()}`;
  private lifecycle?: AbortController;
  private loop?: Promise<void>;
  private active?: Promise<RecordingBackgroundWorkerResult>;
  private activeController?: AbortController;
  private retentionCursor?: RetentionCursor;
  private lastRetentionAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly exports: Pick<RecordingExportService, 'work'>,
    private readonly retention: Pick<RecordingRetentionService, 'sweep'>,
    config: RecordingBackgroundWorkerConfig = {},
    private readonly clock: () => number = Date.now,
  ) {
    const exportLeaseMs = integer(config.exportLeaseMs ?? 60_000, 2_000, 3_600_000, 'lease');
    const exportTimeoutMs = integer(
      config.exportTimeoutMs ?? 45_000,
      1_000,
      exportLeaseMs - 500,
      'timeout',
    );
    this.options = {
      pollIntervalMs: integer(config.pollIntervalMs ?? 5_000, 250, 60_000, 'poll interval'),
      exportLeaseMs,
      exportTimeoutMs,
      exportClaimLimit: integer(config.exportClaimLimit ?? 4, 1, 20, 'export claim limit'),
      exportPolicy: config.exportPolicy,
      retentionIntervalMs: integer(
        config.retentionIntervalMs ?? 60_000,
        1_000,
        86_400_000,
        'retention interval',
      ),
      retentionLimit: integer(config.retentionLimit ?? 20, 1, 100, 'retention limit'),
      onError: config.onError,
    };
  }

  start(): void {
    if (this.lifecycle) return;
    this.lifecycle = new AbortController();
    this.loop = this.runLoop(this.lifecycle.signal);
  }

  async stop(): Promise<void> {
    const lifecycle = this.lifecycle;
    const reason = new Error('Recording background worker stopped');
    lifecycle?.abort(reason);
    this.activeController?.abort(reason);
    if (!lifecycle && !this.active) return;
    await Promise.allSettled([this.loop, this.active].filter(Boolean) as Promise<unknown>[]);
    if (this.lifecycle === lifecycle) {
      this.lifecycle = undefined;
      this.loop = undefined;
    }
  }

  async runOnce(signal?: AbortSignal): Promise<RecordingBackgroundWorkerResult> {
    if (this.active) return { ran: false };
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason ?? new Error('Recording work interrupted'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const operation = this.tick(controller.signal);
    this.activeController = controller;
    this.active = operation;
    try {
      return await operation;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (this.active === operation) this.active = undefined;
      if (this.activeController === controller) this.activeController = undefined;
    }
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.runOnce(signal);
      await delay(this.options.pollIntervalMs, signal);
    }
  }

  private async tick(signal?: AbortSignal): Promise<RecordingBackgroundWorkerResult> {
    const result: RecordingBackgroundWorkerResult = { ran: true };
    const timeout = linkedTimeout(signal, this.options.exportTimeoutMs);
    try {
      result.exports = await this.exports.work({
        owner: this.owner,
        leaseMs: this.options.exportLeaseMs,
        limit: this.options.exportClaimLimit,
        policy: this.options.exportPolicy,
        signal: timeout.signal,
      });
    } catch (error) {
      if (!signal?.aborted) this.report('exports', error);
    } finally {
      timeout.dispose();
    }
    if (signal?.aborted || this.clock() - this.lastRetentionAt < this.options.retentionIntervalMs)
      return result;
    this.lastRetentionAt = this.clock();
    try {
      const page = await this.retention.sweep({
        cursor: this.retentionCursor,
        limit: this.options.retentionLimit,
      });
      result.swept = page.tombstoned;
      result.cleaned = page.cleaned;
      result.cleanupFailed = page.failed;
      this.retentionCursor = page.nextCursor ?? undefined;
    } catch (error) {
      this.report('retention-sweep', error);
    }
    return result;
  }

  private report(operation: RecordingBackgroundWorkerError['operation'], error: unknown): void {
    try {
      this.options.onError?.({
        operation,
        errorType: safeErrorType(error),
      });
    } catch {
      // Operator telemetry must never terminate durable maintenance work.
    }
  }
}

function safeErrorType(error: unknown): string {
  if (!(error instanceof Error)) return 'Error';
  return [
    'AbortError',
    'AggregateError',
    'Error',
    'EvalError',
    'RangeError',
    'ReferenceError',
    'SyntaxError',
    'TimeoutError',
    'TypeError',
    'URIError',
  ].includes(error.name)
    ? error.name
    : 'Error';
}

function integer(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`Invalid recording background ${label}`);
  return value;
}

function linkedTimeout(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason ?? new Error('Recording export interrupted'));
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  const timer = setTimeout(
    () => controller.abort(new Error('Recording export work deadline exceeded')),
    timeoutMs,
  );
  timer.unref();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    },
  };
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref();
    signal.addEventListener('abort', finish, { once: true });
  });
}
