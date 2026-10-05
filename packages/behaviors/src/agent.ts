import type { ValidateFunction } from 'ajv';
import { compileAgentTools, type AgentBehaviorOptions } from './agent-tools.ts';
import {
  AgentTurnLog,
  type AgentDecisionRecord,
  type AgentGroundingRecord,
} from './agent-turn-log.ts';
import type { AgentToolErrorRecord } from './agent-tools.ts';
export {
  AgentToolSelectionError,
  type AgentBehaviorOptions,
  type AgentToolErrorRecord,
} from './agent-tools.ts';
import {
  AgentConfig as AgentConfigSchema,
  type AgentConfig,
  type Behavior,
  type Execution,
  type Inference,
  type OperationRecord,
  type ToolDefinition,
  type SpeechReceipt,
} from '@winsendotai/ovo-contracts';
import { PlaybackConversation } from './history.ts';
import { ToolConfirmation } from './confirmation.ts';
import { ToolEvents } from './tool-events.ts';
import { assembleBoundedContext } from './context.ts';
import { DecisionGate } from './decision-gate.ts';
import { runPreReplySteps } from './agent-pre-reply.ts';
import { resumeConfirmation } from './agent-confirmation-step.ts';
import { Grounding } from './grounding.ts';
import { runInferenceSteps } from './agent-inference-step.ts';

export class AgentBehavior implements Behavior {
  readonly config: AgentConfig;
  readonly assembledContext: string;
  private readonly tools: ToolDefinition[];
  private readonly validators: Map<string, ValidateFunction>;
  private readonly operationId: () => string;
  private active?: AbortController;
  private turn = 0;
  private readonly conversation = new PlaybackConversation();
  private readonly events = new ToolEvents();
  private readonly confirmation = new ToolConfirmation(this.events.emit);
  readonly subscribe = this.events.subscribe;
  speechKind(text: string) {
    return this.confirmation.speechKind(text);
  }
  private uncertainWrite = false;
  private readonly gate?: DecisionGate;
  private readonly grounding?: Grounding;
  private readonly log = new AgentTurnLog();
  /** Tool-selection failures and decisions asked, oldest first, bounded. */
  readonly toolErrors: readonly AgentToolErrorRecord[] = this.log.toolErrors;
  readonly decisions: readonly AgentDecisionRecord[] = this.log.decisions;
  readonly groundings: readonly AgentGroundingRecord[] = this.log.groundings;

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

    const compiled = compileAgentTools(this.config);
    this.tools = compiled.tools;
    this.validators = compiled.validators;
    if (this.config.decision)
      this.gate = new DecisionGate(this.config.decision, this.options.decision);
    if (this.config.knowledge)
      this.grounding = new Grounding(this.config.knowledge, this.options.knowledge);
  }

  async respond(input: string, variables: Record<string, unknown> = {}): Promise<string> {
    const segments: string[] = [];
    for await (const segment of this.runResponse(input, false, variables)) segments.push(segment);
    return segments.join(' ');
  }

  respondStream(input: string, variables: Record<string, unknown> = {}): AsyncIterable<string> {
    return this.runResponse(input, true, variables);
  }

  private async *runResponse(
    input: string,
    streaming: boolean,
    variables: Record<string, unknown> = {},
  ): AsyncIterable<string> {
    this.active?.abort(new DOMException('superseded by a newer turn', 'AbortError'));
    const controller = new AbortController();
    const turn = ++this.turn;
    this.active = controller;
    const results: OperationRecord[] = [];
    const history = this.conversation.user(input);
    let wrote = false;

    try {
      if (this.confirmation.waiting) {
        const resumed = await resumeConfirmation({
          confirmation: this.confirmation,
          events: this.events,
          execution: this.execution,
          input,
          identity: {
            workspaceId: this.options.workspaceId,
            sessionId: this.options.sessionId,
          },
          failure: this.config.processing.failure,
          signal: controller.signal,
          setUncertainWrite: (value) => {
            this.uncertainWrite = value;
          },
        });
        if (resumed.record) results.push(resumed.record);
        if (resumed.kind === 'speak') {
          yield this.conversation.generated(resumed.text);
          return;
        }
        wrote = resumed.wrote;
      }
      const prepared = await runPreReplySteps({
        config: this.config,
        grounding: this.grounding,
        gate: this.gate,
        briefing: this.assembledContext,
        turnInput: { input, history, variables },
        signal: controller.signal,
        log: this.log,
        turn,
        stale: () => turn !== this.turn,
      });
      if (prepared.speak !== undefined) {
        yield this.conversation.generated(prepared.speak);
        return;
      }
      yield* runInferenceSteps({
        config: this.config,
        inference: this.inference,
        execution: this.execution,
        identity: { workspaceId: this.options.workspaceId, sessionId: this.options.sessionId },
        tools: this.tools,
        validators: this.validators,
        log: this.log,
        confirmation: this.confirmation,
        events: this.events,
        conversation: this.conversation,
        operationId: this.operationId,
        turn,
        current: () => turn === this.turn,
        input,
        history,
        context: prepared.context,
        results,
        streaming,
        signal: controller.signal,
        uncertainWrite: () => this.uncertainWrite,
        wrote,
      });
    } finally {
      if (this.active === controller) this.active = undefined;
    }
  }

  cancel(reason = 'agent turn cancelled'): void {
    this.turn += 1;
    this.active?.abort(new DOMException(reason, 'AbortError'));
    this.active = undefined;
    this.confirmation.expire();
  }

  beginTurn(epoch: number): void {
    this.conversation.beginTurn(epoch);
    this.confirmation.beginTurn(epoch);
  }
  onPlayback(receipt: SpeechReceipt): void {
    this.conversation.played(receipt);
    this.confirmation.played(receipt);
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
