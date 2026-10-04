import Ajv, { type ValidateFunction } from 'ajv';
import type { AgentConfig, DecisionPort, KnowledgePort } from '@winsendotai/ovo-contracts';
import { addIsoFormats } from './schema-formats.ts';

export class AgentToolSelectionError extends Error {
  constructor(
    readonly toolId: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentToolSelectionError';
  }
}

export interface AgentBehaviorOptions {
  workspaceId: string;
  sessionId: string;
  operationId?: () => string;
  /** The selected `decision` plugin. Required only when the config authors a decision policy. */
  decision?: DecisionPort;
  /** The selected `knowledge` plugin. Required only when the config authors a knowledge policy. */
  knowledge?: KnowledgePort;
}

export interface AgentToolErrorRecord {
  turn: number;
  toolId: string;
  kind: 'unknown-or-unapproved' | 'invalid-input';
  message: string;
  at: string;
}

export function compileAgentTools(config: AgentConfig) {
  const validators = new Map<string, ValidateFunction>();
  const allowed = new Set(config.allowedTools);
  const tools = config.tools.filter((tool) => allowed.has(tool.id));
  if (new Set(config.tools.map((tool) => tool.id)).size !== config.tools.length) {
    throw new TypeError('Agent tool IDs must be unique');
  }
  const ajv = new Ajv({ allErrors: true, strict: false });
  addIsoFormats(ajv);
  for (const tool of tools) validators.set(tool.id, ajv.compile(tool.inputSchema));
  return { tools, validators };
}
