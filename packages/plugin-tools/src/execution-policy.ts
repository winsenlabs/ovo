import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { ExecutionRequest } from '@winsendotai/ovo-contracts';
import { ConfirmationRequiredError, ExecutionPolicyError, ToolSchemaError } from './errors.ts';
import type {
  CompiledTool,
  ExecutionDependencies,
  ExecutionPluginConfig,
} from './execution-types.ts';

export interface CompiledExecutionPolicy {
  tools: Map<string, CompiledTool>;
  allowed: Set<string>;
}

function fail(message: string): never {
  throw new ExecutionPolicyError(message);
}

export function compileExecutionPolicy(
  config: ExecutionPluginConfig,
  dependencies: ExecutionDependencies,
): CompiledExecutionPolicy {
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  const tools = new Map<string, CompiledTool>();
  for (const definition of config.tools) {
    if (tools.has(definition.id)) fail(`Duplicate tool definition: ${definition.id}`);
    const processing = definition.processing ?? config.processing;
    if (!processing) fail(`Tool ${definition.id} is missing required acknowledgment configuration`);
    if (!processing.initial.trim())
      fail(`Tool ${definition.id} is missing required acknowledgment text`);
    tools.set(definition.id, {
      definition: structuredClone(definition),
      input: ajv.compile(definition.inputSchema),
      output: definition.outputSchema ? ajv.compile(definition.outputSchema) : undefined,
      processing: structuredClone(processing),
    });
  }
  const allowed = new Set(config.allowedTools);
  if (allowed.size !== config.allowedTools.length) fail('Allowed tool IDs must be unique');
  for (const toolId of allowed) {
    const compiled = tools.get(toolId);
    if (!compiled) fail(`Allowed tool is not defined: ${toolId}`);
    if (!dependencies.connectors[compiled.definition.connector])
      fail(`No connector is bound for ${compiled.definition.connector}`);
  }
  return { tools, allowed };
}

export function selectApprovedTool(
  policy: CompiledExecutionPolicy,
  request: ExecutionRequest,
): CompiledTool {
  if (!policy.allowed.has(request.toolId)) {
    throw new ExecutionPolicyError(`Tool is not allowed for this agent: ${request.toolId}`);
  }
  const tool = policy.tools.get(request.toolId)!;
  if ((tool.definition.effect === 'write' || tool.definition.confirmation) && !request.confirmed) {
    throw new ConfirmationRequiredError(`Tool requires caller confirmation: ${request.toolId}`);
  }
  if (!tool.input(request.input)) {
    throw new ToolSchemaError(`Invalid input for tool ${request.toolId}`, tool.input.errors ?? []);
  }
  return tool;
}
