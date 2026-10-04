import type { BehaviorEvent, Execution, ExecutionRequest } from '@winsendotai/ovo-contracts';

export class ToolEvents {
  private readonly listeners = new Set<(event: BehaviorEvent) => void>();
  readonly emit = (event: BehaviorEvent): void => {
    for (const listener of this.listeners) listener(event);
  };
  readonly subscribe = (listener: (event: BehaviorEvent) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  async execute(execution: Execution, request: ExecutionRequest, signal: AbortSignal) {
    const identity = { toolId: request.toolId, operationId: request.id };
    this.emit({ type: 'tool.started', ...identity });
    try {
      return await execution.execute(request, { signal });
    } finally {
      this.emit({ type: 'tool.settled', ...identity });
    }
  }
}
