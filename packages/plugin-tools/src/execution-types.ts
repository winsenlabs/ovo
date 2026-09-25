import type {
  OperationStore,
  ProcessingSpeech,
  Speech,
  ToolConnector,
  ToolDefinition,
} from '@winsendotai/ovo-contracts';
import type { ValidateFunction } from 'ajv';
import type { ConnectorKind } from './services.ts';

export interface ExecutionPluginConfig {
  tools: readonly ToolDefinition[];
  allowedTools: readonly string[];
  processing?: ProcessingSpeech;
}

export interface ExecutionDependencies {
  store: OperationStore;
  speech: Speech;
  connectors: Partial<Record<ConnectorKind, ToolConnector>>;
  now?: () => Date;
}

export interface CompiledTool {
  definition: ToolDefinition;
  input: ValidateFunction;
  output?: ValidateFunction;
  processing: ProcessingSpeech;
}
