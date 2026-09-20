import Ajv, { type ValidateFunction } from 'ajv';
import {
  AgentConfig as AgentConfigSchema,
  type AgentConfig,
  type Behavior,
  type Execution,
  type Inference,
  type OperationRecord,
  type ToolDefinition,
} from '@winsendotai/ovo-contracts';
import { assembleBoundedContext } from './context.ts';
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
}

export interface AgentToolErrorRecord {
  turn: number;
  toolId: string;
  kind: 'unknown-or-unapproved' | 'invalid-input';
  message: string;
  at: string;
}

export class AgentBehavior implements Behavior {
  readonly config: AgentConfig;
  readonly assembledContext: string;
  readonly toolErrors: AgentToolErrorRecord[] = [];
  private readonly tools: ToolDefinition[];
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly operationId: () => string;
  private active?: AbortController;
  private turn = 0;

  constructor(
    config: AgentConfig,
    private readonly inference: Inference,
    private readonly execution: Execution,
    private readonly options: AgentBehaviorOptions,
  ) {
    this.config = AgentConfigSchema.parse(config);
    if (this.config.mode !== 'agent') {
      throw new TypeError(`Agent behavior requires agent mode, received ${this.config.mode}`);
    }
    if (!options.workspaceId || !options.sessionId)
      throw new TypeError('Agent behavior requires workspaceId and sessionId');
    this.assembledContext = assembleBoundedContext(this.config.context, this.config.contextBudget);
    this.operationId = options.operationId ?? (() => crypto.randomUUID());

    const allowed = new Set(this.config.allowedTools);
    this.tools = this.config.tools.filter((tool) => allowed.has(tool.id));
    if (new Set(this.config.tools.map((tool) => tool.id)).size !== this.config.tools.length) {
      throw new TypeError('Agent tool IDs must be unique');
    }
    const ajv = new Ajv({ allErrors: true, strict: false });
    addIsoFormats(ajv);
    for (const tool of this.tools) this.validators.set(tool.id, ajv.compile(tool.inputSchema));
  }

  async respond(input: string, variables: Record<string, unknown> = {}): Promise<string> {
    this.active?.abort(new DOMException('superseded by a newer turn', 'AbortError'));
    const controller = new AbortController();
    const turn = ++this.turn;
    this.active = controller;
    const results: OperationRecord[] = [];

    try {
      for (let step = 0; step < this.config.maxSteps; step += 1) {
        controller.signal.throwIfAborted();
        const reply = await this.inference.generate({
          input,
          context: this.assembledContext,
          uncertainty: this.config.uncertainty,
          tools: this.tools,
          results,
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        if (turn !== this.turn) throw new DOMException('stale agent turn', 'AbortError');

        if (reply.kind === 'text') return reply.text.trim() || this.config.uncertainty;

        const tool = this.tools.find((candidate) => candidate.id === reply.toolId);
        if (!tool) {
          throw this.recordToolError(
            reply.toolId,
            'unknown-or-unapproved',
            `Inference selected unknown or unapproved tool: ${reply.toolId}`,
          );
        }
        const validate = this.validators.get(tool.id)!;
        if (!validate(reply.input)) {
          const reason = validate.errors
            ?.map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
            .join('; ');
          throw this.recordToolError(
            tool.id,
            'invalid-input',
            `Inference supplied invalid input for ${tool.id}: ${reason ?? 'schema mismatch'}`,
          );
        }

        // Execution is the sole policy, durable-intent, acknowledgement, and connector boundary.
        const result = await this.execution.execute(
          {
            id: this.operationId(),
            workspaceId: this.options.workspaceId,
            sessionId: this.options.sessionId,
            toolId: tool.id,
            input: reply.input,
            confirmed: variables.confirmed === true,
          },
          { signal: controller.signal },
        );
        controller.signal.throwIfAborted();
        if (turn !== this.turn) throw new DOMException('stale agent turn', 'AbortError');
        results.push(result);
      }
      return this.config.uncertainty;
    } finally {
      if (this.active === controller) this.active = undefined;
    }
  }

  cancel(reason = 'agent turn cancelled'): void {
    this.turn += 1;
    this.active?.abort(new DOMException(reason, 'AbortError'));
    this.active = undefined;
  }

  private recordToolError(
    toolId: string,
    kind: AgentToolErrorRecord['kind'],
    message: string,
  ): AgentToolSelectionError {
    this.toolErrors.push({ turn: this.turn, toolId, kind, message, at: new Date().toISOString() });
    return new AgentToolSelectionError(toolId, message);
  }
}

export function createAgentBehavior(
  config: AgentConfig,
  inference: Inference,
  execution: Execution,
  options: AgentBehaviorOptions,
): AgentBehavior {
  return new AgentBehavior(config, inference, execution, options);
}
