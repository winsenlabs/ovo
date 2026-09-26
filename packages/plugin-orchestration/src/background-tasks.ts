import { Cap, type BackgroundTask } from '@winsendotai/ovo-contracts';
import { definePlugin, type Context } from '@winsendotai/ovo-runtime';
import type { PostgresOrchestrationStore } from './postgres.ts';
import { SqsDeadLetterQueue, type DeadLetterQueue, type DeadLetterMessage } from './dlq.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type JobHintStore = {
  hints: {
    sweep(limit?: number): Promise<{ hinted: number; poisoned: string[] }>;
    resetHint(jobId: string): Promise<void>;
  };
};

function jobId(message: DeadLetterMessage): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.body ?? '');
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const value = parsed as { schemaVersion?: unknown; jobId?: unknown };
  return value.schemaVersion === 1 && typeof value.jobId === 'string' && uuid.test(value.jobId)
    ? value.jobId
    : undefined;
}

export class JobHintSweeperTask implements BackgroundTask {
  readonly id = 'job-hint-sweeper';
  readonly intervalMs = 5_000;
  readonly jitterMs = 500;

  constructor(
    private readonly store: JobHintStore,
    private readonly log: (entry: Record<string, unknown>) => void = (entry) =>
      console.error(JSON.stringify(entry)),
  ) {}

  async tick(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const result = await this.store.hints.sweep(100);
    for (const id of result.poisoned) this.log({ event: 'hint_exhausted', jobId: id });
  }
}

export class DlqReconcilerTask implements BackgroundTask {
  readonly id = 'dlq-reconciler';
  readonly intervalMs = 5_000;
  readonly jitterMs = 500;
  malformed = 0;

  constructor(
    private readonly store: JobHintStore,
    private readonly queue: DeadLetterQueue,
    private readonly log: (entry: Record<string, unknown>) => void = (entry) =>
      console.error(JSON.stringify(entry)),
  ) {}

  async tick(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    for (const message of await this.queue.receive()) {
      signal.throwIfAborted();
      const id = jobId(message);
      if (!id) {
        this.malformed += 1;
        this.log({ event: 'dlq_malformed', messageId: message.messageId });
      } else {
        await this.store.hints.resetHint(id);
      }
      await this.queue.delete(message);
    }
  }
}

export const jobHintSweeperPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-plugin-orchestration/job-hint-sweeper',
    version: '0.1.0',
    contractVersion: 1,
    scope: 'process',
    requires: [Cap.orchestrationStore],
    provides: [Cap.backgroundTask],
    configSchema: { type: 'object' },
    secretFields: [],
  },
  (ctx: Context) => {
    ctx.provide(
      Cap.backgroundTask,
      new JobHintSweeperTask(ctx.get(Cap.orchestrationStore) as PostgresOrchestrationStore),
    );
  },
);

export const dlqReconcilerPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-plugin-orchestration/dlq-reconciler',
    version: '0.1.0',
    contractVersion: 1,
    scope: 'process',
    requires: [Cap.orchestrationStore],
    provides: [Cap.backgroundTask],
    configSchema: {
      type: 'object',
      required: ['queueUrl', 'region'],
      properties: {
        queueUrl: { type: 'string' },
        region: { type: 'string' },
        endpoint: { type: 'string' },
      },
    },
    secretFields: [],
  },
  (ctx: Context, config) => {
    if (typeof config.queueUrl !== 'string' || !config.queueUrl)
      throw new Error('DLQ URL is required');
    const queue = new SqsDeadLetterQueue(config.queueUrl, {
      region: typeof config.region === 'string' ? config.region : undefined,
      endpoint: typeof config.endpoint === 'string' ? config.endpoint : undefined,
    });
    ctx.provide(
      Cap.backgroundTask,
      new DlqReconcilerTask(ctx.get(Cap.orchestrationStore) as PostgresOrchestrationStore, queue),
    );
    ctx.effect(() => () => queue.destroy());
  },
);

export const plugins = [jobHintSweeperPlugin, dlqReconcilerPlugin];
