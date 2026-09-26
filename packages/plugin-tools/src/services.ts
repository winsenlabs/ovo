import {
  Cap,
  type Execution,
  type ExecutionRequest,
  type OperationRecord,
} from '@winsendotai/ovo-contracts';

export const serviceKeys = {
  execution: Cap.execution,
  operationStore: Cap.operationStore,
  speech: Cap.speech,
  secretResolver: Cap.secrets,
  connector: {
    native: Cap.toolNative,
    http: Cap.toolHttp,
    mcp: Cap.toolMcp,
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
