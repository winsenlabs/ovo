import Ajv, { type ValidateFunction } from 'ajv';
import {
  AgentConfig as AgentConfigSchema,
  type AgentConfig,
  type Behavior,
  type Execution,
  type Inference,
  type InferenceReply,
  type OperationRecord,
  type ToolDefinition,
  type SpeechReceipt,
} from '@winsendotai/ovo-contracts';
import { PlaybackConversation } from './history.ts';
import { ToolConfirmation } from './confirmation.ts';
import { assembleBoundedContext } from './context.ts';
import { addIsoFormats } from './schema-formats.ts';
import { StreamingTextSegmenter } from './text-segmenter.ts';

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
  private readonly conversation = new PlaybackConversation();
  private readonly confirmation = new ToolConfirmation();
  private uncertainWrite = false;

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

  async respond(input: string, _variables: Record<string, unknown> = {}): Promise<string> {
    const segments: string[] = [];
    for await (const segment of this.runResponse(input, false)) segments.push(segment);
    return segments.join(' ');
  }

  respondStream(input: string, _variables: Record<string, unknown> = {}): AsyncIterable<string> {
    return this.runResponse(input, true);
  }

  private async *runResponse(input: string, streaming: boolean): AsyncIterable<string> {
    this.active?.abort(new DOMException('superseded by a newer turn', 'AbortError'));
    const controller = new AbortController();
    const turn = ++this.turn;
    this.active = controller;
    const results: OperationRecord[] = [];
    const history = this.conversation.user(input);
    let wrote = false;

    try {
      if (this.confirmation.waiting) {
        const decision = this.confirmation.accept(input);
        if (decision.kind === 'declined') {
          yield this.conversation.generated('Cancelled. No change was made.');
          return;
        }
        if (decision.kind === 'repeat') {
          yield this.conversation.generated(decision.prompt);
          return;
        }
        const { tool, input: approvedInput, operationId } = decision.selection;
        if (tool.effect === 'write') this.uncertainWrite = true;
        const outcome = await this.execution.execute(
          {
            id: operationId,
            workspaceId: this.options.workspaceId,
            sessionId: this.options.sessionId,
            toolId: tool.id,
            input: approvedInput,
            confirmed: true,
          },
          { signal: controller.signal },
        );
        if (tool.effect === 'write' && ['succeeded', 'failed'].includes(outcome.state))
          this.uncertainWrite = false;
        controller.signal.throwIfAborted();
        results.push(outcome);
        if (outcome.state !== 'succeeded') {
          yield this.conversation.generated(
            tool.processing?.failure ?? this.config.processing.failure,
          );
          return;
        }
        wrote = tool.effect === 'write';
      }
      for (let step = 0; step < this.config.maxSteps; step += 1) {
        controller.signal.throwIfAborted();
        const request = {
          input,
          history,
          context: this.assembledContext,
          uncertainty: this.config.uncertainty,
          tools: this.tools,
          results,
          signal: controller.signal,
        };
        let reply: InferenceReply;
        if (streaming && this.inference.stream) {
          const segmenter = new StreamingTextSegmenter();
          let toolReply: { kind: 'tool'; toolId: string; input: unknown } | undefined;
          let emittedText = false;
          let receivedText = false;
          for await (const event of this.inference.stream(request)) {
            controller.signal.throwIfAborted();
            if (turn !== this.turn) throw new DOMException('stale agent turn', 'AbortError');
            if (event.kind === 'tool') {
              if (receivedText)
                throw new AgentToolSelectionError(
                  event.toolId,
                  'Tool call followed streamed response text',
                );
              if (toolReply) throw new AgentToolSelectionError(event.toolId, 'Multiple tool calls');
              toolReply = event;
            } else if (event.kind === 'text-delta') {
              if (toolReply)
                throw new AgentToolSelectionError(
                  toolReply.toolId,
                  'Streamed response text followed a tool call',
                );
              receivedText ||= Boolean(event.delta);
              for (const segment of segmenter.push(event.delta)) {
                emittedText = true;
                yield this.conversation.generated(segment);
              }
            }
          }
          for (const segment of segmenter.finish()) {
            emittedText = true;
            yield this.conversation.generated(segment);
          }
          if (emittedText) return;
          reply = toolReply ?? { kind: 'text' as const, text: '' };
        } else {
          reply = await this.inference.generate(request);
        }
        controller.signal.throwIfAborted();
        if (turn !== this.turn) throw new DOMException('stale agent turn', 'AbortError');

        if (reply.kind === 'text') {
          yield this.conversation.generated(reply.text.trim() || this.config.uncertainty);
          return;
        }

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

        if (tool.effect === 'write' && this.uncertainWrite) {
          yield this.conversation.generated(
            'A previous change has an unconfirmed outcome. An operator must reconcile it before another change.',
          );
          return;
        }
        if (tool.effect === 'write' && wrote) {
          yield this.conversation.generated(
            'The confirmed action is complete. Please make a separate request for another change.',
          );
          return;
        }
        const operationId = this.operationId();
        if (tool.effect === 'write' || tool.confirmation) {
          yield this.conversation.generated(
            this.confirmation.request({ tool, input: reply.input, operationId }),
          );
          return;
        }

        // Execution is the sole policy, durable-intent, acknowledgement, and connector boundary.
        const result = await this.execution.execute(
          {
            id: operationId,
            workspaceId: this.options.workspaceId,
            sessionId: this.options.sessionId,
            toolId: tool.id,
            input: reply.input,
            confirmed: false,
          },
          { signal: controller.signal },
        );
        controller.signal.throwIfAborted();
        if (turn !== this.turn) throw new DOMException('stale agent turn', 'AbortError');
        results.push(result);
        // A fresh model-selected ID must never turn an uncertain effect into an
        // automatic retry. Surface failure and require explicit reconciliation.
        if (result.state !== 'succeeded') {
          yield this.conversation.generated(
            tool.processing?.failure ?? this.config.processing.failure,
          );
          return;
        }
      }
      yield this.conversation.generated(this.config.uncertainty);
    } finally {
      if (this.active === controller) this.active = undefined;
    }
  }

  cancel(reason = 'agent turn cancelled'): void {
    this.turn += 1;
    this.active?.abort(new DOMException(reason, 'AbortError'));
    this.active = undefined;
  }

  beginTurn(epoch: number): void {
    this.conversation.beginTurn(epoch);
    this.confirmation.beginTurn(epoch);
  }
  onPlayback(receipt: SpeechReceipt): void {
    this.conversation.played(receipt);
    this.confirmation.played(receipt);
  }

  private recordToolError(
    toolId: string,
    kind: AgentToolErrorRecord['kind'],
    message: string,
  ): AgentToolSelectionError {
    this.toolErrors.push({ turn: this.turn, toolId, kind, message, at: new Date().toISOString() });
    if (this.toolErrors.length > 100) this.toolErrors.shift();
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
