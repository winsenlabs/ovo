import type {
  Behavior,
  Execution,
  Inference,
  InferenceReply,
  OperationRecord,
  OperationStore,
  Speech,
  ToolConnector,
} from '@winsendotai/ovo-contracts';
import {
  ExecutingFaqBehavior,
  createAgentBehavior,
  createAnnouncementBehavior,
  createContextBehavior,
  createFaqBehavior,
  withScript,
} from '@winsendotai/ovo-behaviors';
import { createExecutionService } from '@winsendotai/ovo-plugin-tools';
import type {
  EvaluationCase,
  EvaluationCaseResult,
  EvaluationRun,
  ReleaseEvaluationSnapshot,
} from './types.ts';

export const FIXTURE_EXECUTOR_KIND = 'fixture' as const;
export const FIXTURE_EVALUATION_BINDING_VERSION = 'ovo-session-fixtures-v1';

export class FixtureEvaluationExecutor {
  readonly kind = FIXTURE_EXECUTOR_KIND;

  async executeCase(
    run: EvaluationRun,
    release: ReleaseEvaluationSnapshot,
    testCase: EvaluationCase,
    signal?: AbortSignal,
  ): Promise<Omit<EvaluationCaseResult, 'runId' | 'workspaceId' | 'createdAt'>> {
    return executeEvaluationCase(
      run,
      release,
      testCase,
      new FixtureInference(testCase.fixture.inference ?? [], testCase.fixture.inferenceDelayMs),
      signal,
    );
  }
}

/** Executes real behavior logic while keeping every tool and speech side effect local. */
export async function executeEvaluationCase(
  run: EvaluationRun,
  release: ReleaseEvaluationSnapshot,
  testCase: EvaluationCase,
  inference: Inference,
  signal?: AbortSignal,
): Promise<Omit<EvaluationCaseResult, 'runId' | 'workspaceId' | 'createdAt'>> {
  const started = performance.now(),
    records = new MemoryOperationStore(),
    connector = new FixtureConnector(
      testCase.fixture.toolResults ?? {},
      new Set(testCase.fixture.toolFailures ?? []),
    ),
    speech = new FixtureSpeech(),
    sharedExecution = createExecutionService(
      {
        tools: release.config.tools,
        allowedTools: release.config.allowedTools,
        processing: release.config.processing,
      },
      {
        store: records,
        speech,
        connectors: { native: connector, http: connector, mcp: connector },
      },
    ),
    execution: Execution = {
      execute(request, options) {
        records.confirmed.set(request.id, request.confirmed);
        return sharedExecution.execute(request, options);
      },
    },
    outputs: string[] = [];
  let behavior: Behavior | undefined;
  let error: string | undefined;
  const abort = () => behavior?.cancel?.();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (testCase.mode !== release.config.mode)
      throw new Error(
        `Case mode ${testCase.mode} does not match release mode ${release.config.mode}`,
      );
    const currentBehavior = createBehavior(release, inference, execution, run);
    behavior = currentBehavior;
    for (let index = 0; index < testCase.turns.length; index += 1) {
      signal?.throwIfAborted();
      currentBehavior.beginTurn?.(index + 1);
      const turn = testCase.turns[index]!;
      const pending = currentBehavior.respond(turn.input, turn.variables);
      const cancelAfter = testCase.fixture.cancelAfterMs;
      const timer =
        cancelAfter === undefined
          ? undefined
          : setTimeout(() => currentBehavior.cancel?.(), cancelAfter);
      try {
        const output = await pending;
        outputs.push(output);
        currentBehavior.onPlayback?.({
          id: `fixture-playback-${index}`,
          text: output,
          epoch: index + 1,
          state: 'completed',
          evidence: 'simulated',
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  } catch (caught) {
    error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
  } finally {
    signal?.removeEventListener('abort', abort);
    behavior?.cancel?.();
  }
  const operations = records.values().map((record) => ({
    toolId: record.toolId,
    state: record.state,
    confirmed: records.confirmed.get(record.id) ?? false,
  }));
  return {
    caseId: testCase.id,
    mode: testCase.mode,
    passed: matches(testCase, outputs, error, operations),
    outputs,
    error,
    operations,
    durationMs: Math.max(0, Math.round(performance.now() - started)),
  };
}

function createBehavior(
  release: ReleaseEvaluationSnapshot,
  inference: Inference,
  execution: Execution,
  run: EvaluationRun,
): Behavior {
  const config = release.config;
  let behavior: Behavior;
  if (config.mode === 'announcement') behavior = createAnnouncementBehavior(config);
  else if (config.mode === 'faq')
    behavior = config.faq.some((entry) => entry.requiresTool)
      ? new ExecutingFaqBehavior(config, execution, {
          workspaceId: run.workspaceId,
          sessionId: run.id,
        })
      : createFaqBehavior(config);
  else if (config.mode === 'context') behavior = createContextBehavior(config, inference);
  else
    behavior = createAgentBehavior(config, inference, execution, {
      workspaceId: run.workspaceId,
      sessionId: run.id,
      operationId: operationIds(),
    });
  return withScript(config, behavior);
}

class FixtureInference implements Inference {
  private index = 0;
  constructor(
    private readonly replies: InferenceReply[],
    private readonly delayMs = 0,
  ) {}
  async generate(request: Parameters<Inference['generate']>[0]): Promise<InferenceReply> {
    if (this.delayMs) await abortableDelay(this.delayMs, request.signal);
    request.signal.throwIfAborted();
    return structuredClone(this.replies[this.index++] ?? { kind: 'text', text: '' });
  }
}

class FixtureConnector implements ToolConnector {
  constructor(
    private readonly results: Record<string, unknown>,
    private readonly failures: Set<string>,
  ) {}
  async invoke(
    tool: Parameters<ToolConnector['invoke']>[0],
    _input: unknown,
    options: Parameters<ToolConnector['invoke']>[2],
  ) {
    options.signal.throwIfAborted();
    if (this.failures.has(tool.id)) throw new Error(`Fixture connector failure for ${tool.id}`);
    return structuredClone(this.results[tool.id] ?? { ok: true });
  }
}

class FixtureSpeech implements Speech {
  async speak(text: string, options?: Parameters<Speech['speak']>[1]) {
    return {
      id: crypto.randomUUID(),
      text,
      epoch: options?.epoch ?? 0,
      state: 'completed' as const,
      evidence: 'simulated' as const,
    };
  }
  async interrupt() {}
}

class MemoryOperationStore implements OperationStore {
  private readonly records = new Map<string, OperationRecord>();
  readonly confirmed = new Map<string, boolean>();
  async createIntent(record: OperationRecord) {
    if (this.records.has(record.id)) return false;
    this.records.set(record.id, structuredClone(record));
    return true;
  }
  async get(_workspaceId: string, id: string) {
    return structuredClone(this.records.get(id));
  }
  async settle(record: OperationRecord) {
    this.records.set(record.id, structuredClone(record));
  }
  values() {
    return [...this.records.values()].filter((record) =>
      ['succeeded', 'failed', 'unknown'].includes(record.state),
    );
  }
}

function matches(
  testCase: EvaluationCase,
  outputs: string[],
  error: string | undefined,
  operations: EvaluationCaseResult['operations'],
) {
  const expected = testCase.expected;
  if (expected.errorIncludes && !error?.includes(expected.errorIncludes)) return false;
  if (!expected.errorIncludes && error) return false;
  if (expected.outputs && JSON.stringify(outputs) !== JSON.stringify(expected.outputs))
    return false;
  if (expected.outputIncludes?.some((part, index) => !outputs[index]?.includes(part))) return false;
  if (expected.operationCount !== undefined && operations.length !== expected.operationCount)
    return false;
  if (
    expected.operationStates &&
    JSON.stringify(operations.map((item) => item.state)) !==
      JSON.stringify(expected.operationStates)
  )
    return false;
  return true;
}

function operationIds() {
  let id = 0;
  return () => `fixture-operation-${++id}`;
}
function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
