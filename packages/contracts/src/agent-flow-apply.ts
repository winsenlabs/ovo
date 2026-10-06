import {
  FLOW_INTENT_QUESTION,
  FLOW_OTHER_DESCRIPTION,
  FLOW_OTHER_INTENT,
  type FlowIntent,
  type FlowListen,
} from './agent-flow.ts';
import type { CompiledFlow } from './agent-flow-compile.ts';
import { flowListenInstructions } from './agent-flow-queries.ts';
import {
  validateDecisionExchange,
  type DecisionQuestion,
  type DecisionRequest,
  type DecisionResponse,
} from './decision.ts';
import { normalizeForMatch } from './text.ts';

/**
 * Turning the current listen set into one decision request, and the answer back into an intent.
 * Pure, like `agent-decision-apply.ts`: the runtime performs every effect. Node ids, lines and
 * dispositions never reach the model; it reads only the question, the intents' descriptions and
 * the slot options, so it cannot be steered by what its answer will trigger.
 */

function listenOf(compiled: CompiledFlow, listenId: string): FlowListen {
  const listen = compiled.listens.get(listenId);
  if (!listen) throw new Error(`Flow has no listen set ${listenId}`);
  return listen;
}

/** The listen set's own intents first, then the globals. */
export function flowIntents(compiled: CompiledFlow, listenId: string): FlowIntent[] {
  return [...listenOf(compiled, listenId).intents, ...compiled.flow.globalIntents];
}

export function findFlowIntent(
  compiled: CompiledFlow,
  listenId: string,
  key: string,
): FlowIntent | undefined {
  return flowIntents(compiled, listenId).find((intent) => intent.key === key);
}

/**
 * The instant tier: the whole reply is one of an intent's phrases. Zero network, and one lookup in
 * the map `compileFlow` built: the cost grows with the reply's length, not with how many phrases
 * the flow authors (up to 64 local and 16 global intents of 500 phrases each).
 */
export function matchFlowPhrase(
  compiled: CompiledFlow,
  listenId: string,
  reply: string,
): string | undefined {
  listenOf(compiled, listenId);
  const normalized = normalizeForMatch(reply);
  if (!normalized) return undefined;
  return compiled.phrases.get(listenId)?.get(normalized);
}

/** One round trip: the intent among this state's options, plus every slot of the listen set. */
export function flowDecisionRequest(
  compiled: CompiledFlow,
  listenId: string,
  state: Record<string, unknown>,
): DecisionRequest {
  const listen = listenOf(compiled, listenId);
  const criteria: Record<string, string> = {};
  for (const intent of flowIntents(compiled, listenId)) criteria[intent.key] = intent.description;
  criteria[FLOW_OTHER_INTENT] = FLOW_OTHER_DESCRIPTION;
  const questions: Record<string, DecisionQuestion> = {
    [FLOW_INTENT_QUESTION]: {
      type: 'choice',
      instructions: flowListenInstructions(compiled.flow, listen),
      criteria,
    },
  };
  for (const slot of listen.slots)
    questions[slot.id] = {
      type: 'choice',
      instructions: slot.question,
      criteria: Object.fromEntries(slot.options.map((option) => [option.key, option.description])),
    };
  return { state, questions };
}

export type FlowAnswer =
  | {
      kind: 'intent';
      intent: string;
      confidence: number;
      /** Slot answers at or above the threshold; a slot below it is left out. */
      slots: Record<string, string>;
      modelId: string;
    }
  | { kind: 'other' | 'low-confidence'; intent: string; confidence: number; modelId: string };

/**
 * Validate the exchange and apply the flow's threshold. Throws when the response does not answer
 * the request it was given; the caller treats that as an unavailable decision.
 */
export function readFlowAnswer(
  compiled: CompiledFlow,
  request: DecisionRequest,
  rawResponse: unknown,
): FlowAnswer {
  const { response } = validateDecisionExchange(request, rawResponse);
  const answer = choiceOf(response, FLOW_INTENT_QUESTION);
  const { threshold } = compiled.flow;
  const base = { intent: answer.choice, confidence: answer.confidence, modelId: response.modelId };
  if (answer.choice === FLOW_OTHER_INTENT) return { kind: 'other', ...base };
  if (answer.confidence < threshold) return { kind: 'low-confidence', ...base };
  const slots: Record<string, string> = {};
  for (const id of Object.keys(request.questions)) {
    if (id === FLOW_INTENT_QUESTION) continue;
    const slot = choiceOf(response, id);
    if (slot.confidence >= threshold) slots[id] = slot.choice;
  }
  return { kind: 'intent', ...base, slots };
}

function choiceOf(response: DecisionResponse, id: string) {
  const answer = response.answers[id];
  if (answer?.type !== 'choice') throw new Error(`Flow decision ${id} is not a choice answer`);
  return answer;
}

export type FlowTarget = { kind: 'node'; node: string } | { kind: 'repeat' };

/** Where an intent leads, given the slot answers of the same turn. */
export function routeFlowIntent(
  intent: FlowIntent,
  slots: Readonly<Record<string, string>>,
): FlowTarget {
  const route = intent.next;
  if (route === undefined) return { kind: 'repeat' };
  if (typeof route === 'string') return { kind: 'node', node: route };
  const value = slots[route.slot];
  return {
    kind: 'node',
    node: (value === undefined ? undefined : route.cases[value]) ?? route.otherwise,
  };
}
