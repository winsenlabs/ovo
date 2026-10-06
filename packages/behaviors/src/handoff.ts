import Ajv, { type ValidateFunction } from 'ajv';
import {
  agentHandoffLines,
  SCHEDULE_CALLBACK_TOOL_ID,
  TRANSFER_CALL_TOOL_ID,
  TRANSFER_REASON_PREFIX,
  type AgentConfig,
  type EventSink,
  type Execution,
  type ExecutionRequest,
  type FlowTransition,
  type JsonSchema,
  type OperationRecord,
  type ToolDefinition,
} from '@winsendotai/ovo-contracts';
import { validateTemplatePaths } from './announcement.ts';
import { callbackRequest, recordCallback } from './callback.ts';
import type { DecisionGateResult } from './decision-gate.ts';
import type { FlowSession } from './flow-session.ts';
import { handoffTools, requestedCallback, toolReason } from './handoff-tools.ts';
import { recordSessionEvent } from './outcome-events.ts';
import type { RecoveryPlan } from './reprompt.ts';

export * from './callback.ts';
export * from './handoff-tools.ts';

/** The disposition a transfer records when no flow node names one. */
export const TRANSFER_DISPOSITION = 'transfer_to_human';

export interface AgentHandoffHost {
  events?: EventSink;
  now: () => Date;
  turn: () => number;
  /** Arms the call's ending; it completes once this turn's lines have played. */
  arm: (reason: string) => void;
}

/**
 * AGT-15 inside one agent call: which turns hand the caller to a person, and which promise a
 * callback. A transfer is only decided here. The agent says its line and completes with a
 * `transfer:` reason, which the engine ends as `transferred`; the host then hands the carrier leg
 * to the configured target instead of hanging it up. A callback is recorded as a disposition event
 * with a `callback` field, which the API keeps as a durable callback.
 *
 * Without a `handoff` block nothing here changes a turn.
 */
export class AgentHandoffs {
  private readonly transfer;
  private readonly callback;

  constructor(
    private readonly config: AgentConfig,
    private readonly host: AgentHandoffHost,
    schema: JsonSchema,
  ) {
    this.transfer = config.handoff?.transfer;
    this.callback = config.handoff?.callback;
    for (const line of agentHandoffLines(config)) validateTemplatePaths(line.text, schema);
  }

  /** Adds the built-in tools the LLM may call beside the authored ones. */
  offer(tools: ToolDefinition[], validators: Map<string, ValidateFunction>): void {
    const offered = handoffTools(this.config.handoff);
    if (!offered.length) return;
    const ajv = new Ajv({ allErrors: true, strict: false });
    for (const tool of offered) {
      tools.push(tool);
      validators.set(tool.id, ajv.compile(tool.inputSchema));
    }
  }

  /** Callback nodes promise a callback as the flow enters them, however it got there. */
  follow(flow: FlowSession | undefined): void {
    const nodes = this.callback?.nodes;
    if (!flow || !nodes || !Object.keys(nodes).length) return;
    flow.onTransition((moved) => this.enteredNode(moved));
  }

  /**
   * A turn that goes to a person instead: the decision model was unavailable, or the re-asks ran
   * out. Undefined keeps the turn as it was routed.
   */
  divert(
    route: { kind: 'recover'; plan: RecoveryPlan } | { kind: 'answer' },
    verdict: DecisionGateResult | undefined,
  ): RecoveryPlan | undefined {
    const transfer = this.transfer;
    if (!transfer) return undefined;
    let cause: string | undefined;
    if (transfer.onDecisionUnavailable && unavailable(verdict)) cause = 'decision:unavailable';
    else if (
      transfer.onRecoveryExhausted &&
      route.kind === 'recover' &&
      route.plan.end === 'recovery:exhausted'
    )
      cause = 'recovery:exhausted';
    if (!cause) return undefined;
    this.recordTransfer(cause, 'system');
    return {
      lines: [{ field: 'handoff.transfer.line', text: transfer.line }],
      end: `${TRANSFER_REASON_PREFIX}${cause}`,
    };
  }

  /** A flow end node configured to transfer completes as a transfer rather than a hang-up. */
  completionReason(reason: string | undefined): string | undefined {
    const node = reason?.startsWith('decision:flow:') ? reason.slice('decision:flow:'.length) : '';
    return node && this.transfer?.nodes.includes(node)
      ? `${TRANSFER_REASON_PREFIX}flow:${node}`
      : reason;
  }

  /** Runs the built-in tools here; every other tool goes to `inner`. */
  execution(inner: Execution): Execution {
    return {
      execute: (request, options) =>
        request.toolId === TRANSFER_CALL_TOOL_ID || request.toolId === SCHEDULE_CALLBACK_TOOL_ID
          ? Promise.resolve(this.runTool(request))
          : inner.execute(request, options),
    };
  }

  private runTool(request: ExecutionRequest): OperationRecord {
    const input = (request.input ?? {}) as Record<string, unknown>;
    const record = {
      id: request.id,
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      toolId: request.toolId,
      input: request.input,
      createdAt: this.host.now().toISOString(),
    };
    const reason = toolReason(input);
    if (request.toolId === TRANSFER_CALL_TOOL_ID) {
      this.host.arm(`${TRANSFER_REASON_PREFIX}llm`);
      this.recordTransfer('llm', 'llm', reason);
      return {
        ...record,
        state: 'succeeded',
        result: {
          status: 'transferring',
          instruction: 'Say one short sentence that you are connecting them. Ask nothing else.',
        },
      };
    }
    const policy = this.callback;
    if (!policy || !this.host.events)
      return { ...record, state: 'failed', error: 'Callbacks cannot be scheduled on this call' };
    const callback = callbackRequest(policy, {
      when: requestedCallback(input),
      now: this.host.now(),
      timezone: this.config.timezone,
      source: 'llm',
      ...(reason ? { reason } : {}),
    });
    recordCallback(this.host.events, {
      turn: this.host.turn(),
      disposition: 'callback',
      source: 'llm',
      request: callback,
    });
    this.host.arm('llm:schedule_callback');
    return {
      ...record,
      state: 'succeeded',
      result: {
        status: 'scheduled',
        due: spokenTime(new Date(callback.dueAt), this.config),
        instruction: 'Confirm this time in one short sentence and say goodbye.',
      },
    };
  }

  private enteredNode(moved: FlowTransition): void {
    const node = moved.to.node;
    const policy = this.callback;
    if (!policy || !node || node === moved.from.node || !Object.hasOwn(policy.nodes, node)) return;
    recordCallback(this.host.events, {
      turn: this.host.turn(),
      disposition: moved.disposition ?? 'callback',
      source: 'flow',
      request: callbackRequest(policy, {
        when: policy.nodes[node],
        now: this.host.now(),
        timezone: this.config.timezone,
        source: 'flow',
        node,
      }),
    });
  }

  private recordTransfer(cause: string, source: 'system' | 'llm', reason?: string): void {
    recordSessionEvent(this.host.events, 'disposition', {
      disposition: TRANSFER_DISPOSITION,
      turn: this.host.turn(),
      source,
      reason: reason ? `transfer:${cause}:${reason}`.slice(0, 200) : `transfer:${cause}`,
    });
  }
}

/** The decision model gave no usable answer on this turn, flat or in a flow. */
export function unavailable(verdict: DecisionGateResult | undefined): boolean {
  if (verdict?.kind === 'unavailable') return true;
  return verdict?.kind === 'flow' && verdict.step.kind === 'fallback' && !!verdict.step.unavailable;
}

function spokenTime(at: Date, config: Pick<AgentConfig, 'locale' | 'timezone'>): string {
  return new Intl.DateTimeFormat(config.locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: config.timezone,
  }).format(at);
}
