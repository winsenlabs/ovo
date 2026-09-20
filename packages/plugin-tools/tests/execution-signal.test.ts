import { describe, expect, it } from 'vitest';
import type {
  OperationRecord,
  OperationStore,
  Speech,
  SpeechReceipt,
  ToolDefinition,
} from '@winsendotai/ovo-contracts';
import { createExecutionService } from '../src/index.ts';

class MemoryOperations implements OperationStore {
  record?: OperationRecord;

  async createIntent(record: OperationRecord): Promise<boolean> {
    if (this.record) return false;
    this.record = structuredClone(record);
    return true;
  }

  async get(): Promise<OperationRecord | undefined> {
    return this.record && structuredClone(this.record);
  }

  async settle(record: OperationRecord): Promise<void> {
    this.record = structuredClone(record);
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function definition(effect: 'read' | 'write' = 'read'): ToolDefinition {
  return {
    id: 'remote',
    description: 'Remote operation',
    connector: 'native',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    effect,
    confirmation: effect === 'write',
    timeoutMs: 1_000,
    processing: {
      initial: 'Working.',
      progress: 'Still working.',
      progressAfterMs: 100,
      maxProgress: 1,
      failure: 'Failed.',
    },
  };
}

const request = {
  id: 'operation-1',
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
  toolId: 'remote',
  input: {},
  confirmed: true,
};

function recordingSpeech(spoken: string[]): Speech {
  return {
    async speak(text, options) {
      spoken.push(options?.kind ?? text);
      return { id: text, text, epoch: 0, state: 'completed', evidence: 'confirmed' };
    },
    async interrupt() {},
  };
}

describe('execution caller cancellation', () => {
  it('persists a pre-aborted request without acknowledgment or side effect', async () => {
    const store = new MemoryOperations();
    const spoken: string[] = [];
    let invoked = 0;
    const caller = new AbortController();
    caller.abort(new DOMException('Newer turn', 'AbortError'));
    const service = createExecutionService(
      { tools: [definition()], allowedTools: ['remote'] },
      {
        store,
        speech: recordingSpeech(spoken),
        connectors: {
          native: {
            async invoke() {
              invoked += 1;
              return {};
            },
          },
        },
      },
    );

    await expect(service.execute(request, { signal: caller.signal })).resolves.toMatchObject({
      state: 'failed',
      error: 'Tool invocation cancelled',
    });
    expect(store.record?.state).toBe('failed');
    expect(invoked).toBe(0);
    expect(spoken).toEqual([]);
  });

  it.each([
    { effect: 'read' as const, expectedState: 'failed' as const },
    { effect: 'write' as const, expectedState: 'unknown' as const },
  ])(
    'propagates caller abort to an in-flight $effect operation',
    async ({ effect, expectedState }) => {
      const store = new MemoryOperations();
      const spoken: string[] = [];
      const started = deferred<void>();
      const late = deferred<unknown>();
      const caller = new AbortController();
      const service = createExecutionService(
        { tools: [definition(effect)], allowedTools: ['remote'] },
        {
          store,
          speech: recordingSpeech(spoken),
          connectors: {
            native: {
              async invoke() {
                started.resolve(undefined);
                return late.promise;
              },
            },
          },
        },
      );

      const pending = service.execute(request, { signal: caller.signal });
      await started.promise;
      caller.abort(new DOMException('Newer turn', 'AbortError'));
      await expect(pending).resolves.toMatchObject({ state: expectedState });
      const terminal = store.record;
      late.resolve({ stale: true });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(store.record).toEqual(terminal);
      expect(spoken.filter((kind) => kind === 'progress')).toEqual([]);
    },
  );

  it('does not hold a newer turn behind uncooperative connector or acknowledgment promises', async () => {
    const store = new MemoryOperations();
    const started = deferred<void>();
    const lateResult = deferred<unknown>();
    const lateAcknowledgment = deferred<SpeechReceipt>();
    const caller = new AbortController();
    const service = createExecutionService(
      { tools: [definition('write')], allowedTools: ['remote'] },
      {
        store,
        speech: {
          async speak() {
            return lateAcknowledgment.promise;
          },
          async interrupt() {},
        },
        connectors: {
          native: {
            async invoke() {
              started.resolve(undefined);
              return lateResult.promise;
            },
          },
        },
      },
    );

    const pending = service.execute(request, { signal: caller.signal });
    await started.promise;
    caller.abort(new DOMException('Newer turn', 'AbortError'));
    await expect(pending).resolves.toMatchObject({ state: 'unknown' });
    expect(store.record?.state).toBe('unknown');

    lateResult.resolve({ stale: true });
    lateAcknowledgment.resolve({
      id: 'late-ack',
      text: 'Working.',
      epoch: 0,
      state: 'completed',
      evidence: 'confirmed',
    });
  });

  it('bounds an uncooperative acknowledgment while preserving a fast successful result', async () => {
    const store = new MemoryOperations();
    const neverAcknowledged = new Promise<SpeechReceipt>(() => undefined);
    const boundedDefinition = { ...definition(), timeoutMs: 5 };
    const service = createExecutionService(
      { tools: [boundedDefinition], allowedTools: ['remote'] },
      {
        store,
        speech: {
          async speak() {
            return neverAcknowledged;
          },
          async interrupt() {},
        },
        connectors: {
          native: {
            async invoke() {
              return { found: true };
            },
          },
        },
      },
    );

    await expect(service.execute(request)).resolves.toMatchObject({
      state: 'succeeded',
      result: { found: true },
    });
    expect(store.record).toMatchObject({ state: 'succeeded', result: { found: true } });
  });

  it('handles a connector operation that rejects after acknowledgment synchronously aborts', async () => {
    const store = new MemoryOperations();
    const caller = new AbortController();
    let invoked = 0;
    const service = createExecutionService(
      { tools: [definition()], allowedTools: ['remote'] },
      {
        store,
        speech: {
          speak(text) {
            caller.abort(new DOMException('Newer turn', 'AbortError'));
            return Promise.resolve({
              id: text,
              text,
              epoch: 0,
              state: 'completed',
              evidence: 'confirmed',
            });
          },
          async interrupt() {},
        },
        connectors: {
          native: {
            async invoke() {
              invoked += 1;
              return {};
            },
          },
        },
      },
    );

    await expect(service.execute(request, { signal: caller.signal })).resolves.toMatchObject({
      state: 'failed',
      error: 'Tool invocation cancelled',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(invoked).toBe(0);
  });
});
