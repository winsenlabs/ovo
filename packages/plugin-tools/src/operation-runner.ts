import type { ExecutionRequest, OperationRecord } from '@winsendotai/ovo-contracts';
import { ToolInvocationError, ToolSchemaError, OperationCollisionError } from './errors.ts';
import type { CompiledTool, ExecutionDependencies } from './execution-types.ts';
import { schemaDigest } from './json.ts';
import { startOperationSpeech } from './acknowledgment.ts';

export function operationKey(workspaceId: string, id: string): string {
  return `${workspaceId}\u0000${id}`;
}

export function operationFingerprint(
  record: Pick<OperationRecord, 'workspaceId' | 'sessionId' | 'toolId' | 'input'>,
): string {
  return schemaDigest({
    workspaceId: record.workspaceId,
    sessionId: record.sessionId,
    toolId: record.toolId,
    input: record.input,
  });
}

function messageFor(error: unknown): string {
  const message =
    error instanceof ToolInvocationError || error instanceof ToolSchemaError
      ? error.message
      : error instanceof Error && error.name === 'AbortError'
        ? 'Tool invocation cancelled'
        : 'Tool connector failed';
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Operation cancelled', 'AbortError');
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function settleCancelledBeforeStart(
  record: OperationRecord,
  dependencies: ExecutionDependencies,
): Promise<OperationRecord> {
  const settled: OperationRecord = {
    ...record,
    state: 'failed',
    error: 'Tool invocation cancelled',
  };
  await dependencies.store.settle(settled);
  return settled;
}

export async function runOperation(
  request: ExecutionRequest,
  tool: CompiledTool,
  controller: AbortController,
  dependencies: ExecutionDependencies,
): Promise<OperationRecord> {
  const input = structuredClone(request.input);
  const intent: OperationRecord = {
    id: request.id,
    workspaceId: request.workspaceId,
    sessionId: request.sessionId,
    toolId: request.toolId,
    input,
    state: 'intent',
    createdAt: (dependencies.now ?? (() => new Date()))().toISOString(),
  };
  const intendedFingerprint = operationFingerprint(intent);
  const created = await dependencies.store.createIntent(intent);
  if (!created) {
    const existing = await dependencies.store.get(request.workspaceId, request.id);
    if (!existing)
      throw new OperationCollisionError(`Operation ${request.id} exists but cannot be read`);
    if (operationFingerprint(existing) !== intendedFingerprint) {
      throw new OperationCollisionError(
        `Operation ID ${request.id} was already used for a different request`,
      );
    }
    return existing;
  }

  if (controller.signal.aborted) return settleCancelledBeforeStart(intent, dependencies);

  const running: OperationRecord = { ...intent, state: 'running' };
  await dependencies.store.settle(running);
  if (controller.signal.aborted) return settleCancelledBeforeStart(running, dependencies);
  const connector = dependencies.connectors[tool.definition.connector]!;
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('Tool deadline exceeded', 'TimeoutError'));
  }, tool.definition.timeoutMs);
  const speech = startOperationSpeech(tool.processing, dependencies.speech);
  let effectStarted = false;
  const connectorOperation = Promise.resolve().then(() => {
    if (controller.signal.aborted) throw abortError(controller.signal);
    effectStarted = true;
    return connector.invoke(tool.definition, input, {
      signal: controller.signal,
      operationId: request.id,
      workspaceId: request.workspaceId,
    });
  });
  const invocation = raceWithAbort(connectorOperation, controller.signal);

  let settled: OperationRecord;
  try {
    const result = await invocation;
    if (tool.output && !tool.output(result)) {
      throw new ToolSchemaError(
        `Tool ${request.toolId} returned an invalid result`,
        tool.output.errors ?? [],
      );
    }
    settled = { ...running, state: 'succeeded', result: structuredClone(result) };
  } catch (error) {
    const explicitOutcome = error instanceof ToolInvocationError ? error.outcome : undefined;
    const unknown =
      tool.definition.effect === 'write' &&
      effectStarted &&
      (timedOut || controller.signal.aborted || explicitOutcome !== 'not-applied');
    settled = {
      ...running,
      state: unknown ? 'unknown' : 'failed',
      error: timedOut ? 'Tool deadline exceeded' : messageFor(error),
    };
  } finally {
    clearTimeout(deadline);
    speech.stopProgress();
  }
  await dependencies.store.settle(settled);
  await speech.acknowledgment;
  return settled;
}
