import type { Execution, ExecutionRequest, OperationRecord } from '@winsendotai/ovo-contracts';

export const serviceKeys = {
  execution: 'ovo.execution',
  operationStore: 'ovo.operation-store',
  speech: 'ovo.speech',
  secretResolver: 'ovo.secret-resolver',
  connector: {
    native: 'ovo.tool-connector.native',
    http: 'ovo.tool-connector.http',
    mcp: 'ovo.tool-connector.mcp',
  },
} as const;

export type ConnectorKind = keyof typeof serviceKeys.connector;

export interface ExecutionOptions {
  signal?: AbortSignal;
}

export interface ExecutionService extends Execution {
  execute(request: ExecutionRequest, options?: ExecutionOptions): Promise<OperationRecord>;
  cancel(workspaceId: string, operationId: string): boolean;
}
