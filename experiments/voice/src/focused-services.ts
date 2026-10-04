import { MockLanguageModelV4 } from 'ai/test';
import type { OperationRecord, OperationStore } from '@winsendotai/ovo-contracts';
import { definePlugin, type PluginDefinition } from '@winsendotai/ovo-runtime';
import { Deferred, type TraceRecorder } from './harness.ts';

export const MEMORY_OPERATION_STORE_SERVICE = 'ovo.operation-store';

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

export class DeterministicToolModel {
  requests = 0;
  #trace?: TraceRecorder;

  readonly model = new MockLanguageModelV4({
    doGenerate: async () => {
      this.requests += 1;
      this.#trace?.add('model.requested', { request: this.requests });
      return {
        content: [
          {
            type: 'tool-call' as const,
            toolCallType: 'function' as const,
            toolCallId: `call-${this.requests}`,
            toolName: 'check_balance',
            input: JSON.stringify({ account: 'A-42' }),
          },
        ],
        finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
        usage,
        warnings: [],
      };
    },
  });

  traceWith(trace?: TraceRecorder): void {
    this.#trace = trace;
  }
}

export class MemoryOperationStore implements OperationStore {
  readonly #records = new Map<string, OperationRecord>();
  #latest?: OperationRecord;
  #trace?: TraceRecorder;

  traceWith(trace?: TraceRecorder): void {
    this.#trace = trace;
  }

  async createIntent(record: OperationRecord): Promise<boolean> {
    const key = this.key(record.workspaceId, record.id);
    if (this.#records.has(key)) return false;
    this.#records.set(key, structuredClone(record));
    this.#latest = structuredClone(record);
    this.#trace?.add('operation.intent.simulated-memory', { operationId: record.id });
    return true;
  }

  async get(workspaceId: string, id: string): Promise<OperationRecord | undefined> {
    const record = this.#records.get(this.key(workspaceId, id));
    return record ? structuredClone(record) : undefined;
  }

  async settle(record: OperationRecord): Promise<void> {
    this.#records.set(this.key(record.workspaceId, record.id), structuredClone(record));
    this.#latest = structuredClone(record);
    this.#trace?.add(`operation.${record.state}.simulated-memory`, { operationId: record.id });
  }

  latest(): OperationRecord | undefined {
    return this.#latest ? structuredClone(this.#latest) : undefined;
  }

  private key(workspaceId: string, id: string): string {
    return `${workspaceId}\u0000${id}`;
  }
}

export class ControlledNativeTool {
  started = new Deferred<void>();
  release = new Deferred<void>();
  attempts = 0;
  #trace?: TraceRecorder;

  begin(trace: TraceRecorder): void {
    this.started = new Deferred<void>();
    this.release = new Deferred<void>();
    this.attempts = 0;
    this.#trace = trace;
  }

  async invoke(): Promise<{ balance: number }> {
    this.attempts += 1;
    if (this.attempts !== 1) throw new Error('native fixture received a duplicate execution');
    this.#trace?.add('operation.handler.started');
    this.started.resolve();
    await this.release.promise;
    this.#trace?.add('operation.handler.settled');
    return { balance: 42 };
  }

  clear(): void {
    this.#trace = undefined;
  }
}

export function createMemoryOperationStorePlugin(store: MemoryOperationStore): PluginDefinition {
  return definePlugin(
    {
      id: 'experiment.voice.memory-operation-store',
      version: '0.1.0',
      contractVersion: 1,
      scope: 'session',
      provides: [MEMORY_OPERATION_STORE_SERVICE],
      requires: [],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    (ctx) => {
      ctx.provide(MEMORY_OPERATION_STORE_SERVICE, store);
    },
  );
}
