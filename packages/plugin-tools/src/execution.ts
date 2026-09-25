import type { OperationRecord } from '@winsendotai/ovo-contracts';
import { OperationCollisionError } from './errors.ts';
import { compileExecutionPolicy, selectApprovedTool } from './execution-policy.ts';
import type { ExecutionDependencies, ExecutionPluginConfig } from './execution-types.ts';
import { operationFingerprint, operationKey, runOperation } from './operation-runner.ts';
import type { ExecutionService } from './services.ts';

export function createExecutionService(
  config: ExecutionPluginConfig,
  dependencies: ExecutionDependencies,
): ExecutionService {
  const policy = compileExecutionPolicy(config, dependencies);
  const inFlight = new Map<
    string,
    {
      fingerprint: string;
      promise: Promise<OperationRecord>;
      controller: AbortController;
    }
  >();

  return {
    execute(request, options) {
      const tool = selectApprovedTool(policy, request);
      const key = operationKey(request.workspaceId, request.id);
      const fingerprint = operationFingerprint({ ...request, input: request.input });
      const active = inFlight.get(key);
      if (active) {
        if (active.fingerprint !== fingerprint) {
          throw new OperationCollisionError(
            `Operation ID ${request.id} is already running for a different request`,
          );
        }
        return active.promise;
      }
      const controller = new AbortController();
      const abortFromCaller = () => controller.abort(options?.signal?.reason);
      if (options?.signal?.aborted) abortFromCaller();
      else options?.signal?.addEventListener('abort', abortFromCaller, { once: true });
      const promise = runOperation(request, tool, controller, dependencies).finally(() => {
        options?.signal?.removeEventListener('abort', abortFromCaller);
        inFlight.delete(key);
      });
      inFlight.set(key, { fingerprint, promise, controller });
      return promise;
    },
    cancel(workspaceId, operationId) {
      const active = inFlight.get(operationKey(workspaceId, operationId));
      if (!active) return false;
      active.controller.abort(new DOMException('Operation cancelled', 'AbortError'));
      return true;
    },
  };
}
