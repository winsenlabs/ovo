import {
  validateDecisionExchange,
  type DecisionPort,
  type DecisionRequest,
} from '@winsendotai/ovo-contracts';
import {
  FLOW_INTENT_QUESTION,
  FLOW_OTHER_INTENT,
  flowDecisionRequest,
  flowIntents,
  flowListen,
  matchFlowPhrase,
  renderFlowLine,
  routeFlowIntent,
  type AgentFlow,
} from './jev-eval-flow.ts';

/**
 * The Jev routing eval (critic item): labelled caller replies per listen set, routed the way a call
 * routes them (the instant phrase tier, then one decision request, then the flow's threshold), and
 * scored per listen set, language and tag with a confusion matrix and an accuracy gate. Run it
 * before every flow or decision-policy change; `pnpm eval:jev` prints the report.
 */

export type JevEvalLanguage = 'en' | 'en-IN' | 'hinglish';
/** Predicted when the decision could not be had at all (error, timeout, stale recording). */
export const UNAVAILABLE = 'unavailable';

export interface JevEvalCase {
  id: string;
  listen: string;
  /** The node whose lines the caller is answering. Default: the first node with this listen set. */
  node?: string;
  /** The caller's words as speech-to-text delivered them. */
  text: string;
  /** An intent of the listen set, a global intent, or `other` when nothing scripted fits. */
  expected: string;
  /** Expected slot answers. Scored only when the expected intent routes on that slot. */
  slots?: Record<string, string>;
  language: JevEvalLanguage;
  /** short, noisy, backchannel, qualified, slot, ... */
  tags: string[];
}

export interface JevEvalGate {
  minAccuracy: number;
  minListenAccuracy: number;
  minSlotAccuracy: number;
}

export interface JevEvalSet {
  name: string;
  flow: AgentFlow;
  /** Sample call variables, so `agent_last_said` is the line a caller actually heard. */
  variables: Record<string, string>;
  today: string;
  cases: JevEvalCase[];
  gate: JevEvalGate;
}

export type JevEvalTier = 'rule' | 'decision' | 'error';

export interface JevEvalOutcome {
  id: string;
  listen: string;
  text: string;
  language: JevEvalLanguage;
  tags: string[];
  expected: string;
  predicted: string;
  tier: JevEvalTier;
  correct: boolean;
  /** Undefined when the case has no slot to score. */
  slotCorrect?: boolean;
  confidence?: number;
  /** The model's raw choice when the threshold turned it into `other`. */
  modelChoice?: string;
  error?: string;
}

/** The decision state of one case: what was asked, what the agent just said, what came back. */
export function jevEvalRequest(set: JevEvalSet, evalCase: JevEvalCase): DecisionRequest {
  const listen = flowListen(set.flow, evalCase.listen);
  if (!listen) throw new Error(`Case ${evalCase.id}: unknown listen set ${evalCase.listen}`);
  const nodeId =
    evalCase.node ?? set.flow.nodes.find((node) => node.listen === evalCase.listen)?.id;
  const node = set.flow.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`Case ${evalCase.id}: no node listens with ${evalCase.listen}`);
  const said = node.say.map((line) => renderFlowLine(set.flow, line, set.variables)).join(' ');
  return flowDecisionRequest(set.flow, evalCase.listen, {
    current_state_question: listen.question,
    agent_last_said: said,
    recent_turns: [`agent: ${said}`],
    caller_reply: evalCase.text,
    today: set.today,
  });
}

/** Labels that cannot be scored, or one reply labelled twice in one state, are a broken corpus. */
export function validateJevEvalSet(set: JevEvalSet): JevEvalSet {
  const ids = new Set<string>();
  const replies = new Set<string>();
  for (const evalCase of set.cases) {
    const where = `Case ${evalCase.id}`;
    if (ids.has(evalCase.id)) throw new Error(`${where} is duplicated`);
    ids.add(evalCase.id);
    const listen = flowListen(set.flow, evalCase.listen);
    if (!listen) throw new Error(`${where}: unknown listen set ${evalCase.listen}`);
    const keys = flowIntents(set.flow, evalCase.listen).map((intent) => intent.key);
    if (![...keys, FLOW_OTHER_INTENT].includes(evalCase.expected))
      throw new Error(`${where}: ${evalCase.expected} is not an intent of ${evalCase.listen}`);
    for (const [slot, value] of Object.entries(evalCase.slots ?? {}))
      if (!listen.slots.find((s) => s.id === slot)?.options.some((o) => o.key === value))
        throw new Error(`${where}: ${slot}=${value} is not a slot option of ${evalCase.listen}`);
    if (!evalCase.text.trim()) throw new Error(`${where}: empty caller reply`);
    const reply = JSON.stringify(jevEvalRequest(set, evalCase));
    if (replies.has(reply)) throw new Error(`${where}: the same reply in the same state twice`);
    replies.add(reply);
  }
  return set;
}

/** The slot an intent routes on, if any. */
function routingSlot(set: JevEvalSet, listen: string, intent: string): string | undefined {
  const next = flowIntents(set.flow, listen).find((candidate) => candidate.key === intent)?.next;
  return next !== undefined && typeof next !== 'string' ? next.slot : undefined;
}

export async function scoreJevCase(
  set: JevEvalSet,
  evalCase: JevEvalCase,
  decision: DecisionPort,
  signal: AbortSignal = new AbortController().signal,
): Promise<JevEvalOutcome> {
  const base = {
    id: evalCase.id,
    listen: evalCase.listen,
    text: evalCase.text,
    language: evalCase.language,
    tags: evalCase.tags,
    expected: evalCase.expected,
  };
  const slot = routingSlot(set, evalCase.listen, evalCase.expected);
  const expectedSlot = slot === undefined ? undefined : evalCase.slots?.[slot];
  const scored = (
    predicted: string,
    slots: Record<string, string>,
    extra: Pick<JevEvalOutcome, 'tier'> & Partial<JevEvalOutcome>,
  ): JevEvalOutcome => {
    const correct = predicted === evalCase.expected;
    const slotCorrect =
      expectedSlot === undefined
        ? undefined
        : correct && sameTarget(set, evalCase, slots, { [slot!]: expectedSlot });
    return {
      ...base,
      predicted,
      correct,
      ...(slotCorrect === undefined ? {} : { slotCorrect }),
      ...extra,
    };
  };

  const rule = matchFlowPhrase(set.flow, evalCase.listen, evalCase.text);
  if (rule !== undefined) return scored(rule, {}, { tier: 'rule' });
  const request = jevEvalRequest(set, evalCase);
  try {
    const { response } = validateDecisionExchange(
      request,
      await decision.decide(request, { signal }),
    );
    const intent = response.answers[FLOW_INTENT_QUESTION];
    if (intent?.type !== 'choice') throw new Error('The intent answer is not a choice');
    const trusted = intent.choice !== FLOW_OTHER_INTENT && intent.confidence >= set.flow.threshold;
    const slots: Record<string, string> = {};
    for (const [id, answer] of Object.entries(response.answers))
      if (id !== FLOW_INTENT_QUESTION && answer.type === 'choice')
        if (answer.confidence >= set.flow.threshold) slots[id] = answer.choice;
    return scored(trusted ? intent.choice : FLOW_OTHER_INTENT, slots, {
      tier: 'decision',
      confidence: intent.confidence,
      ...(trusted ? {} : { modelChoice: intent.choice }),
    });
  } catch (error) {
    return scored(
      UNAVAILABLE,
      {},
      {
        tier: 'error',
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

/** A slot answer is right when it takes the call to the same node the labelled answer would. */
function sameTarget(
  set: JevEvalSet,
  evalCase: JevEvalCase,
  actual: Record<string, string>,
  expected: Record<string, string>,
): boolean {
  const target = (slots: Record<string, string>) => {
    const route = routeFlowIntent(set.flow, evalCase.listen, evalCase.expected, slots);
    return route?.kind === 'node' ? route.node : route?.kind;
  };
  return target(actual) === target(expected);
}

export async function runJevEval(
  set: JevEvalSet,
  decision: DecisionPort,
  options: { signal?: AbortSignal } = {},
): Promise<JevEvalOutcome[]> {
  validateJevEvalSet(set);
  const outcomes: JevEvalOutcome[] = [];
  for (const evalCase of set.cases)
    outcomes.push(await scoreJevCase(set, evalCase, decision, options.signal));
  return outcomes;
}
