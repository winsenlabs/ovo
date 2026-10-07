import Ajv, { type ValidateFunction } from 'ajv';
import {
  END_CALL_TOOL_ID,
  type AgentConfig,
  type DecisionPort,
  type EventSink,
  type KnowledgePort,
  type ToolDefinition,
} from '@winsendotai/ovo-contracts';
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
  /** The clock behind the date built-ins (`today`, `date_tomorrow`, `date_week`). */
  now?: () => Date;
  /** Where routing verdicts and guardrail verdicts are recorded for the call (AGT-8). */
  events?: EventSink;
}

export interface AgentToolErrorRecord {
  turn: number;
  toolId: string;
  /** `protocol`: tool and text out of order, or two tool calls in one reply. */
  kind: 'unknown-or-unapproved' | 'invalid-input' | 'protocol';
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
  if (config.ending?.llmTool) tools.push(END_CALL_TOOL);
  for (const tool of tools) validators.set(tool.id, ajv.compile(tool.inputSchema));
  return { tools, validators };
}

/**
 * Offered to the LLM when `ending.llmTool` is on. It never reaches Execution: the behaviour speaks
 * the goodbye and ends the call once it has played.
 */
export const END_CALL_TOOL: ToolDefinition = {
  id: END_CALL_TOOL_ID,
  description:
    'End the phone call. Call this instead of replying, only once the conversation is finished ' +
    'and the caller has nothing more to ask; put your closing sentence in `goodbye`.',
  connector: 'native',
  inputSchema: {
    type: 'object',
    required: ['goodbye'],
    properties: {
      goodbye: { type: 'string', minLength: 1, maxLength: 500 },
      reason: { type: 'string', maxLength: 120 },
    },
    additionalProperties: false,
  },
  effect: 'read',
  confirmation: false,
  timeoutMs: 1_000,
};

/** Only an offered `end_call` with valid input ends the call; anything else is a protocol error. */
export function isEndCall(
  tools: readonly ToolDefinition[],
  validators: ReadonlyMap<string, ValidateFunction>,
  input: unknown,
): boolean {
  const validate = validators.get(END_CALL_TOOL_ID);
  return Boolean(validate && tools.some((tool) => tool.id === END_CALL_TOOL_ID) && validate(input));
}

/** The completion reason of an LLM's `end_call`, with the reason it gave. */
export function endCallReason(input: unknown): string {
  const reason = (input as { reason?: unknown }).reason;
  return typeof reason === 'string' && reason.trim()
    ? `llm:end_call:${reason.trim()}`
    : 'llm:end_call';
}
