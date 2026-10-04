import { describe, expect, it, vi } from 'vitest';
import type {
  OperationRecord,
  OperationStore,
  Speech,
  SpeechReceipt,
  ToolConnector,
  ToolDefinition,
} from '@winsendotai/ovo-contracts';
import {
  ConfirmationRequiredError,
  createExecutionPlugin,
  createExecutionService,
  ExecutionPolicyError,
  OperationCollisionError,
  ToolSchemaError,
} from '../src/index.ts';

class MemoryOperations implements OperationStore {
  readonly records = new Map<string, OperationRecord>();
  readonly states: OperationRecord['state'][] = [];
  failCreate = false;

  async createIntent(record: OperationRecord): Promise<boolean> {
    if (this.failCreate) throw new Error('database unavailable');
    const key = `${record.workspaceId}:${record.id}`;
    if (this.records.has(key)) return false;
    this.states.push(record.state);
    this.records.set(key, structuredClone(record));
    return true;
  }

  async get(workspaceId: string, id: string): Promise<OperationRecord | undefined> {
    const record = this.records.get(`${workspaceId}:${id}`);
    return record && structuredClone(record);
  }

  async settle(record: OperationRecord): Promise<void> {
    this.states.push(record.state);
    this.records.set(`${record.workspaceId}:${record.id}`, structuredClone(record));
  }
}

function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    id: 'lookup',
    description: 'Looks up a record',
    connector: 'native',
    inputSchema: {
      type: 'object',
      properties: { account: { type: 'string' } },
      required: ['account'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { found: { type: 'boolean' } },
      required: ['found'],
      additionalProperties: false,
    },
    effect: 'read',
    confirmation: false,
    timeoutMs: 100,
    processing: {
      initial: 'Checking now.',
      progressAfterMs: 50,
      maxProgress: 0,
      failure: 'Check failed.',
    },
    ...overrides,
  };
}

function speech(receipts: Array<{ text: string; kind?: string }>, wait?: Promise<void>): Speech {
  return {
    async speak(text, options): Promise<SpeechReceipt> {
      receipts.push({ text, kind: options?.kind });
      await wait;
      return {
        id: `speech-${receipts.length}`,
        text,
        epoch: options?.epoch ?? 0,
        state: 'completed',
        evidence: 'confirmed',
      };
    },
    async interrupt() {},
  };
}

const request = {
  id: 'op-1',
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
  toolId: 'lookup',
  input: { account: 'A-1' },
  confirmed: true,
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('tool execution', () => {
  it('rejects missing acknowledgment configuration at release construction', () => {
    const definition = tool();
    delete definition.processing;
    expect(() =>
      createExecutionService(
        { tools: [definition], allowedTools: ['lookup'] },
        {
          store: new MemoryOperations(),
          speech: speech([]),
          connectors: {
            native: {
              async invoke() {
                return { found: true };
              },
            },
          },
        },
      ),
    ).toThrow('missing required acknowledgment configuration');
  });

  it('runs the tool concurrently with exactly one acknowledgment and gates the result', async () => {
    const acknowledgment = deferred<void>();
    const calls: string[] = [];
    const store = new MemoryOperations();
    const connector: ToolConnector = {
      async invoke() {
        calls.push('invoke');
        return { found: true };
      },
    };
    const spoken: Array<{ text: string; kind?: string }> = [];
    const service = createExecutionService(
      { tools: [tool()], allowedTools: ['lookup'] },
      {
        store,
        speech: speech(spoken, acknowledgment.promise),
        connectors: { native: connector },
      },
    );

    let returned = false;
    const pending = service.execute(request).then((value) => {
      returned = true;
      return value;
    });
    await vi.waitFor(() => expect(calls).toEqual(['invoke']));
    await vi.waitFor(() => expect(store.states).toEqual(['intent', 'running', 'succeeded']));
    expect(returned).toBe(false);
    expect(spoken).toEqual([{ text: 'Checking now.', kind: 'acknowledgment' }]);
    acknowledgment.resolve(undefined);
    await expect(pending).resolves.toMatchObject({ state: 'succeeded', result: { found: true } });
  });

  it('rejects permission, confirmation, and schema violations before durable intent', async () => {
    const store = new MemoryOperations();
    const connector: ToolConnector = {
      async invoke() {
        return { found: true };
      },
    };
    const service = createExecutionService(
      {
        tools: [tool(), tool({ id: 'write', effect: 'write', confirmation: false })],
        allowedTools: ['write'],
      },
      { store, speech: speech([]), connectors: { native: connector } },
    );

    expect(() => service.execute(request)).toThrow(ExecutionPolicyError);
    expect(() => service.execute({ ...request, toolId: 'write', confirmed: false })).toThrow(
      ConfirmationRequiredError,
    );
    expect(() => service.execute({ ...request, toolId: 'write', input: { account: 42 } })).toThrow(
      ToolSchemaError,
    );
    expect(store.records.size).toBe(0);
  });

  it('never starts speech or an effect if intent persistence fails', async () => {
    const store = new MemoryOperations();
    store.failCreate = true;
    let invoked = 0;
    const spoken: Array<{ text: string; kind?: string }> = [];
    const service = createExecutionService(
      { tools: [tool()], allowedTools: ['lookup'] },
      {
        store,
        speech: speech(spoken),
        connectors: {
          native: {
            async invoke() {
              invoked += 1;
              return { found: true };
            },
          },
        },
      },
    );
    await expect(service.execute(request)).rejects.toThrow('database unavailable');
    expect(invoked).toBe(0);
    expect(spoken).toEqual([]);
  });

  it('deduplicates an operation and rejects ID collisions', async () => {
    const gate = deferred<unknown>();
    const store = new MemoryOperations();
    let calls = 0;
    const spoken: Array<{ text: string; kind?: string }> = [];
    const service = createExecutionService(
      { tools: [tool()], allowedTools: ['lookup'] },
      {
        store,
        speech: speech(spoken),
        connectors: {
          native: {
            async invoke() {
              calls += 1;
              return gate.promise;
            },
          },
        },
      },
    );
    const first = service.execute(request);
    const duplicate = service.execute(structuredClone(request));
    expect(duplicate).toBe(first);
    expect(() => service.execute({ ...request, input: { account: 'different' } })).toThrow(
      OperationCollisionError,
    );
    gate.resolve({ found: true });
    await first;
    await expect(service.execute(request)).resolves.toMatchObject({ state: 'succeeded' });
    expect(calls).toBe(1);
    expect(spoken).toHaveLength(1);
  });

  it('marks an ambiguous timed-out write unknown and does not retry', async () => {
    const store = new MemoryOperations();
    let calls = 0;
    const write = tool({ id: 'write', effect: 'write', confirmation: true, timeoutMs: 5 });
    const service = createExecutionService(
      { tools: [write], allowedTools: ['write'] },
      {
        store,
        speech: speech([]),
        connectors: {
          native: {
            async invoke(_tool, _input, { signal }) {
              calls += 1;
              await new Promise<void>((_resolve, reject) =>
                signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
              );
            },
          },
        },
      },
    );
    await expect(service.execute({ ...request, toolId: 'write' })).resolves.toMatchObject({
      state: 'unknown',
      error: 'Tool deadline exceeded',
    });
    expect(calls).toBe(1);
  });

  it.each([
    { effect: 'read' as const, expectedState: 'failed' as const },
    { effect: 'write' as const, expectedState: 'unknown' as const },
  ])(
    'settles an uncooperative $effect connector without accepting its late result',
    async ({ effect, expectedState }) => {
      const lateResult = deferred<unknown>();
      const store = new MemoryOperations();
      const spoken: Array<{ text: string; kind?: string }> = [];
      let calls = 0;
      const definition = tool({ effect, confirmation: effect === 'write', timeoutMs: 5 });
      const service = createExecutionService(
        { tools: [definition], allowedTools: ['lookup'] },
        {
          store,
          speech: speech(spoken),
          connectors: {
            native: {
              async invoke() {
                calls += 1;
                return lateResult.promise;
              },
            },
          },
        },
      );

      await expect(service.execute(request)).resolves.toMatchObject({
        state: expectedState,
        error: 'Tool deadline exceeded',
      });
      expect(calls).toBe(1);
      expect(spoken).toEqual([{ text: 'Checking now.', kind: 'acknowledgment' }]);

      lateResult.resolve({ found: true });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(store.get('workspace-1', 'op-1')).resolves.toMatchObject({
        state: expectedState,
      });
      expect(spoken).toHaveLength(1);
    },
  );

  it('cancels after durable intent but before acknowledgment or side-effect start', async () => {
    const store = new MemoryOperations();
    const intentPersisted = deferred<void>();
    const releaseCreate = deferred<void>();
    const createIntent = store.createIntent.bind(store);
    store.createIntent = async (record) => {
      const created = await createIntent(record);
      intentPersisted.resolve(undefined);
      await releaseCreate.promise;
      return created;
    };
    let invoked = 0;
    const spoken: Array<{ text: string; kind?: string }> = [];
    const service = createExecutionService(
      { tools: [tool()], allowedTools: ['lookup'] },
      {
        store,
        speech: speech(spoken),
        connectors: {
          native: {
            async invoke() {
              invoked += 1;
              return { found: true };
            },
          },
        },
      },
    );

    const pending = service.execute(request);
    await intentPersisted.promise;
    expect(service.cancel('workspace-1', 'op-1')).toBe(true);
    releaseCreate.resolve(undefined);

    await expect(pending).resolves.toMatchObject({
      state: 'failed',
      error: 'Tool invocation cancelled',
    });
    expect(store.states).toEqual(['intent', 'failed']);
    expect(invoked).toBe(0);
    expect(spoken).toEqual([]);
  });

  it('cancels an in-flight connector and persists the bounded terminal state', async () => {
    const store = new MemoryOperations();
    const service = createExecutionService(
      { tools: [tool()], allowedTools: ['lookup'] },
      {
        store,
        speech: speech([]),
        connectors: {
          native: {
            async invoke(_tool, _input, { signal }) {
              await new Promise<void>((_resolve, reject) =>
                signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
              );
            },
          },
        },
      },
    );
    const pending = service.execute(request);
    await vi.waitFor(() => expect(store.states).toContain('running'));
    expect(service.cancel('workspace-1', 'op-1')).toBe(true);
    await expect(pending).resolves.toMatchObject({
      state: 'failed',
      error: 'Tool invocation cancelled',
    });
    expect(service.cancel('workspace-1', 'op-1')).toBe(false);
  });

  it('bounds progress speech and suppresses it after settlement', async () => {
    vi.useFakeTimers();
    try {
      const gate = deferred<unknown>();
      const spoken: Array<{ text: string; kind?: string }> = [];
      const progressTool = tool({
        processing: {
          initial: 'Checking now.',
          progress: 'Still checking.',
          progressAfterMs: 10,
          maxProgress: 2,
          failure: 'Check failed.',
        },
      });
      const service = createExecutionService(
        { tools: [progressTool], allowedTools: ['lookup'] },
        {
          store: new MemoryOperations(),
          speech: speech(spoken),
          connectors: {
            native: {
              async invoke() {
                return gate.promise;
              },
            },
          },
        },
      );
      const pending = service.execute(request);
      await vi.advanceTimersByTimeAsync(25);
      expect(spoken.filter(({ kind }) => kind === 'progress')).toHaveLength(2);
      gate.resolve({ found: true });
      await pending;
      await vi.advanceTimersByTimeAsync(100);
      expect(spoken.filter(({ kind }) => kind === 'progress')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('declares exact Cordis requirements for the selected connectors', () => {
    const plugin = createExecutionPlugin({
      tools: [
        tool(),
        tool({
          id: 'remote',
          connector: 'mcp',
          connectionId: 'c-1',
          remoteName: 'remote',
          schemaDigest: 'digest',
        }),
      ],
      allowedTools: ['lookup', 'remote'],
    });
    expect(plugin.manifest.requires).toEqual([
      'ovo.operation-store',
      'ovo.speech',
      'ovo.tool-connector.native',
      'ovo.tool-connector.mcp',
    ]);
    expect(plugin.manifest.provides).toEqual(['ovo.execution']);
  });
});
