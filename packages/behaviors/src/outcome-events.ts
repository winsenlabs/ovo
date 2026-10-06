import type {
  DecisionAnswer,
  DecisionResolution,
  EventSink,
  FlowTransition,
  RouteTier,
  TurnRoutePayload,
} from '@winsendotai/ovo-contracts';
import type { DecisionGateResult } from './decision-gate.ts';
import type { FlowSession } from './flow-session.ts';
import type { FlowStep } from './flow-types.ts';
import { RULES_MODEL_ID } from './rules-gate.ts';
import type { AgentDecisionRecord } from './agent-turn-log.ts';

/**
 * The `turn.route` event for an agent turn: its decision verdict when one was recorded for this
 * turn, otherwise `none` for a turn answered before the LLM (a knowledge refusal) or `llm`.
 */
export function turnRouteEvent(
  turn: number,
  decisions: readonly AgentDecisionRecord[],
  answered: boolean,
): TurnRoutePayload | null {
  const decision = decisions.at(-1);
  if (decision?.turn === turn) return routeEventFromDecision(turn, decision.result);
  return { turn, tier: answered ? 'none' : 'llm' };
}

/**
 * The `turn.route` event (AGT-8) for one decision verdict. The tier is the one that produced the
 * reply: `jev` when a trusted outcome spoke, ended or asked to clarify, `llm` when the turn went on
 * to the LLM. `null` for a disabled policy, which is not an event.
 */
export function routeEventFromDecision(
  turn: number,
  result: DecisionGateResult,
): TurnRoutePayload | null {
  if (result.kind === 'off') return null;
  if (result.kind === 'unavailable') return { turn, tier: 'llm', fallbackReason: result.reason };
  if (result.kind === 'flow') return routeEventFromFlow(turn, result.step);
  const chosen = result.resolutions.find((resolution) => resolution.used) ?? result.resolutions[0];
  const answered = result.action.say !== undefined || result.action.clarify || result.action.end;
  return {
    turn,
    // The instant rules tier (AGT-6) answered every question when its own model id is the verdict's.
    tier: answered ? (result.modelId === RULES_MODEL_ID ? 'rule' : 'jev') : 'llm',
    modelId: result.modelId,
    ...(chosen
      ? {
          intent: `${chosen.questionId}=${answerLabel(chosen.answer)}`,
          confidence: chosen.answer.confidence,
          top3: top3(chosen),
        }
      : {}),
    ...(result.action.clarify ? { fallbackReason: 'clarify' } : {}),
    ...(!answered && result.resolutions.some((resolution) => !resolution.used)
      ? { fallbackReason: 'low_confidence' }
      : {}),
  };
}

/**
 * A flow turn: the node and listen set it was judged in, and the tier that moved it. A clarify
 * fallback is the decision tier answering, unless the decision was unavailable.
 */
function routeEventFromFlow(turn: number, step: FlowStep): TurnRoutePayload {
  const { transition } = step;
  const tier: RouteTier =
    transition.tier === 'rule'
      ? 'rule'
      : transition.tier === 'llm' || (step.kind === 'fallback' && step.action === 'llm')
        ? 'llm'
        : transition.tier === 'start'
          ? 'none'
          : step.kind === 'fallback' && step.unavailable
            ? 'none'
            : 'jev';
  return {
    turn,
    tier,
    ...(transition.from.node ? { node: transition.from.node } : {}),
    ...(transition.from.listen ? { listen: transition.from.listen } : {}),
    ...(transition.intent ? { intent: transition.intent } : {}),
    ...(transition.confidence !== undefined ? { confidence: transition.confidence } : {}),
    ...(transition.slots ? { slots: transition.slots } : {}),
    ...(transition.modelId ? { modelId: transition.modelId } : {}),
    ...(transition.reason ? { fallbackReason: transition.reason.replace('-', '_') } : {}),
  };
}

/**
 * A committed flow transition as outcome events (AGT-8): the state it entered, the disposition that
 * node records, and the slot answers the decision captured. A turn that stays put enters no state.
 */
export function recordFlowTransition(
  sink: EventSink | undefined,
  turn: number,
  transition: FlowTransition,
): void {
  const { from, to } = transition;
  if (to.node && to.node !== from.node)
    recordSessionEvent(sink, 'flow.state', {
      turn,
      ...(from.node ? { from: from.node } : {}),
      to: to.node,
      reason: transition.reason ?? transition.tier,
    });
  if (transition.disposition)
    recordSessionEvent(sink, 'disposition', {
      disposition: transition.disposition,
      turn,
      ...(to.node ? { node: to.node } : {}),
      source: DISPOSITION_SOURCE[transition.tier],
    });
  if (transition.slots && Object.keys(transition.slots).length)
    recordSessionEvent(sink, 'variables.captured', { turn, variables: transition.slots });
}

const DISPOSITION_SOURCE: Record<FlowTransition['tier'], RouteTier | 'system'> = {
  start: 'system',
  rule: 'rule',
  decision: 'jev',
  fallback: 'none',
  llm: 'llm',
};

/** One call's outcome events from the agent: each turn's route and each flow transition. */
export class CallOutcomeEvents {
  constructor(
    private readonly sink: EventSink | undefined,
    private readonly log: { readonly decisions: readonly AgentDecisionRecord[] },
  ) {}

  /** Records every committed transition of the call's flow, at the turn that made it. */
  follow(flow: FlowSession | undefined, turn: () => number): void {
    const sink = this.sink;
    if (sink) flow?.onTransition((moved) => recordFlowTransition(sink, turn(), moved));
  }

  /** A turn answered before the LLM (a decision line, a refusal, a re-ask) has a `say` or recovers. */
  routed(turn: number, route: { kind: string; say?: string }): void {
    const answered = route.kind === 'recover' || route.say !== undefined;
    recordSessionEvent(this.sink, 'turn.route', turnRouteEvent(turn, this.log.decisions, answered));
  }
}

/** Appends without waiting: a sink queues, and the turn must never wait on outcome storage. */
export function recordSessionEvent(
  sink: EventSink | undefined,
  type: string,
  payload: Record<string, unknown> | null,
): void {
  if (!sink || !payload) return;
  void sink.append(type, payload);
}

function answerLabel(answer: DecisionAnswer): string {
  if (answer.type === 'choice') return answer.choice;
  if (answer.type === 'noul') return answer.noul >= 0.5 ? 'yes' : 'no';
  return String(answer.score);
}

function top3(resolution: DecisionResolution): TurnRoutePayload['top3'] {
  const ranked = Object.entries(resolution.answer.probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([intent, confidence]) => ({ intent, confidence }));
  return ranked.length ? ranked : undefined;
}
