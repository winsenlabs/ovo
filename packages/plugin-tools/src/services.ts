import type { Execution } from '@winsendotai/ovo-contracts';

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

export interface ExecutionService extends Execution {
  cancel(workspaceId: string, operationId: string): boolean;
}
