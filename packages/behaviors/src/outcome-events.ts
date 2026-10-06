import type {
  DecisionAnswer,
  DecisionResolution,
  EventSink,
  TurnRoutePayload,
} from '@winsendotai/ovo-contracts';
import type { DecisionGateResult } from './decision-gate.ts';
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
  const chosen = result.resolutions.find((resolution) => resolution.used) ?? result.resolutions[0];
  const answered = result.action.say !== undefined || result.action.clarify || result.action.end;
  return {
    turn,
    tier: answered ? 'jev' : 'llm',
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
