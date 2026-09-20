import type { JsonSchema, ToolDefinition } from '@winsendotai/ovo-contracts';
import { canonicalJson, schemaDigest } from '@winsendotai/ovo-plugin-tools';

export interface McpDiscoveredTool {
  remoteName: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  schemaDigest: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface McpDiscovery {
  connectionId: string;
  tools: McpDiscoveredTool[];
}

export interface McpDiscoveryRequest {
  workspaceId: string;
  connectionId: string;
  signal?: AbortSignal;
}

export interface McpApproval {
  workspaceId: string;
  connectionId: string;
  remoteName: string;
  schemaDigest: string;
}

export interface RemoteToolShape {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: McpDiscoveredTool['annotations'];
}

export function mcpSchemaDigest(
  tool: Pick<RemoteToolShape, 'inputSchema' | 'outputSchema'>,
): string {
  return schemaDigest({ inputSchema: tool.inputSchema, outputSchema: tool.outputSchema ?? null });
}

export function toDiscoveredTool(tool: RemoteToolShape): McpDiscoveredTool {
  return {
    remoteName: tool.name,
    description: tool.description,
    inputSchema: structuredClone(tool.inputSchema),
    outputSchema: tool.outputSchema ? structuredClone(tool.outputSchema) : undefined,
    schemaDigest: mcpSchemaDigest(tool),
    annotations: tool.annotations ? structuredClone(tool.annotations) : undefined,
  };
}

export function toolDefinitionMatchesDiscovery(
  tool: ToolDefinition,
  remote: McpDiscoveredTool,
): boolean {
  return (
    tool.connector === 'mcp' &&
    tool.remoteName === remote.remoteName &&
    tool.schemaDigest === remote.schemaDigest &&
    canonicalJson(tool.inputSchema) === canonicalJson(remote.inputSchema) &&
    canonicalJson(tool.outputSchema ?? null) === canonicalJson(remote.outputSchema ?? null)
  );
}
