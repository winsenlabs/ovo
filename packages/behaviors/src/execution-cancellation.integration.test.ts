import { describe, expect, it, vi } from 'vitest';
import {
  AgentConfig,
  type Inference,
  type InferenceRequest,
  type OperationRecord,
  type OperationStore,
  type Speech,
  type SpeechReceipt,
  type ToolConnector,
  type ToolDefinition,
} from '@winsendotai/ovo-contracts';
import { createExecutionService } from '../../plugin-tools/src/index.ts';
import { createAgentBehavior } from './agent.ts';

class MemoryOperations implements OperationStore {
  readonly records = new Map<string, OperationRecord>();

  async createIntent(record: OperationRecord): Promise<boolean> {
    const key = `${record.workspaceId}:${record.id}`;
    if (this.records.has(key)) return false;
    this.records.set(key, structuredClone(record));
    return true;
  }

  async get(workspaceId: string, id: string): Promise<OperationRecord | undefined> {
    const record = this.records.get(`${workspaceId}:${id}`);
    return record && structuredClone(record);
  }

  async settle(record: OperationRecord): Promise<void> {
    this.records.set(`${record.workspaceId}:${record.id}`, structuredClone(record));
  }
}

class RecordingSpeech implements Speech {
  readonly spoken: Array<{ text: string; kind?: string }> = [];

  async speak(
    text: string,
    options?: { epoch?: number; kind?: 'acknowledgment' | 'response' | 'progress' },
  ): Promise<SpeechReceipt> {
    this.spoken.push({ text, kind: options?.kind });
    return {
      id: `speech-${this.spoken.length}`,
      text,
      epoch: options?.epoch ?? 0,
      state: 'completed',
      evidence: 'simulated',
    };
  }

  async interrupt(): Promise<void> {}
}

class TurnInference implements Inference {
  readonly requests: InferenceRequest[] = [];
  staleNarrations = 0;

  constructor(private readonly toolId: string) {}

  async generate(request: InferenceRequest) {
    this.requests.push(request);
    if (request.results.length > 0) {
      this.staleNarrations += 1;
      return { kind: 'text' as const, text: 'STALE OPERATION RESULT' };
    }
    if (request.input === 'new turn') return { kind: 'text' as const, text: 'Fresh response.' };
    return { kind: 'tool' as const, toolId: this.toolId, input: { account: 'A-1' } };
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function definition(effect: 'read' | 'write'): ToolDefinition {
  return {
    id: `${effect}-account`,
    description: `${effect} an account fixture`,
    connector: 'native',
    inputSchema: {
      type: 'object',
      required: ['account'],
      properties: { account: { type: 'string' } },
      additionalProperties: false,
    },
    effect,
    confirmation: effect === 'write',
    timeoutMs: 5_000,
    processing: {
      initial: 'Working.',
      progress: 'Still working.',
      progressAfterMs: 40,
      maxProgress: 3,
      failure: 'Operation failed.',
    },
  };
}

function createHarness(effect: 'read' | 'write') {
  const tool = definition(effect);
  const store = new MemoryOperations();
  const speech = new RecordingSpeech();
  const pendingConnector = deferred<unknown>();
  let invocations = 0;
  let connectorSignal: AbortSignal | undefined;
  const connector: ToolConnector = {
    async invoke(_tool, _input, options) {
      invocations += 1;
      connectorSignal = options.signal;
      return pendingConnector.promise;
    },
  };
  const execution = createExecutionService(
    { tools: [tool], allowedTools: [tool.id] },
    { store, speech, connectors: { native: connector } },
  );
  const inference = new TurnInference(tool.id);
  const behavior = createAgentBehavior(
    AgentConfig.parse({
      name: `${effect} fixture`,
      mode: 'agent',
      maxSteps: 2,
      tools: [tool],
      allowedTools: [tool.id],
    }),
    inference,
    execution,
    {
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      operationId: () => `${effect}-operation`,
    },
  );
  return {
    behavior,
    connectorSignal: () => connectorSignal,
    inference,
    invocations: () => invocations,
    pendingConnector,
    speech,
    store,
  };
}

async function waitForExecutionReadiness(harness: ReturnType<typeof createHarness>): Promise<void> {
  await vi.waitFor(() => expect(harness.invocations()).toBe(1));
  await vi.waitFor(() => {
    expect(harness.speech.spoken.filter((item) => item.kind === 'progress').length).toBeGreaterThan(
      0,
    );
  });
}

describe('AgentBehavior and shared Execution cancellation', () => {
  it('supersedes a pending read, aborts its connector, and stops stale progress/results', async () => {
    const harness = createHarness('read');
    const staleTurn = harness.behavior.respond('old turn');
    await waitForExecutionReadiness(harness);

    await expect(harness.behavior.respond('new turn')).resolves.toBe('Fresh response.');
    await expect(staleTurn).rejects.toMatchObject({ name: 'AbortError' });
    expect(harness.connectorSignal()?.aborted).toBe(true);
    expect(await harness.store.get('workspace-1', 'read-operation')).toMatchObject({
      state: 'failed',
    });

    const progressAtCancellation = harness.speech.spoken.filter(
      (item) => item.kind === 'progress',
    ).length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(harness.speech.spoken.filter((item) => item.kind === 'progress')).toHaveLength(
      progressAtCancellation,
    );
    expect(harness.inference.staleNarrations).toBe(0);
  });

  it('marks a started cancelled write unknown, never retries, and ignores its late result', async () => {
    const harness = createHarness('write');
    harness.behavior.beginTurn(0);
    const prompt = await harness.behavior.respond('old turn');
    expect(harness.invocations()).toBe(0);
    harness.behavior.onPlayback({
      id: 'confirmation-prompt',
      text: prompt,
      epoch: 0,
      state: 'completed',
      evidence: 'confirmed',
    });
    harness.behavior.beginTurn(1);
    const staleTurn = harness.behavior.respond('yes');
    await waitForExecutionReadiness(harness);

    harness.behavior.beginTurn(2);
    await expect(harness.behavior.respond('new turn')).resolves.toBe('Fresh response.');
    await expect(staleTurn).rejects.toMatchObject({ name: 'AbortError' });
    expect(await harness.store.get('workspace-1', 'write-operation')).toMatchObject({
      state: 'unknown',
    });
    expect(harness.invocations()).toBe(1);
    const progressAtCancellation = harness.speech.spoken.filter(
      (item) => item.kind === 'progress',
    ).length;

    harness.pendingConnector.resolve({ applied: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await harness.store.get('workspace-1', 'write-operation')).toMatchObject({
      state: 'unknown',
    });
    expect(harness.invocations()).toBe(1);
    expect(harness.inference.staleNarrations).toBe(0);
    expect(harness.speech.spoken.filter((item) => item.kind === 'progress')).toHaveLength(
      progressAtCancellation,
    );
  });

  it('propagates explicit behavior cancellation to a pending execution', async () => {
    const harness = createHarness('read');
    const cancelledTurn = harness.behavior.respond('old turn');
    await waitForExecutionReadiness(harness);

    harness.behavior.cancel('caller disconnected');
    await expect(cancelledTurn).rejects.toMatchObject({ name: 'AbortError' });
    expect(harness.connectorSignal()?.aborted).toBe(true);
    expect(await harness.store.get('workspace-1', 'read-operation')).toMatchObject({
      state: 'failed',
    });
    expect(harness.inference.staleNarrations).toBe(0);
    const progressAtCancellation = harness.speech.spoken.filter(
      (item) => item.kind === 'progress',
    ).length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(harness.speech.spoken.filter((item) => item.kind === 'progress')).toHaveLength(
      progressAtCancellation,
    );
  });
});
