import {
  FLOW_INTENT_QUESTION,
  FLOW_OTHER_DESCRIPTION,
  FLOW_OTHER_INTENT,
  validateDecisionExchange,
  type DecisionRequest,
  type ScriptGraph,
} from '@winsendotai/ovo-contracts';

/**
 * AGT-14: a deterministic script can use the decision model too, scoped exactly like a flow state.
 *
 * A script node's text transitions are its listen set: one option per target node, described by the
 * replies the author wrote for it, plus the automatic `other`. The model only widens matching
 * ("yeah sure" for a transition written as "yes"); it never invents a path, and exact matches are
 * still tried first with no network at all. A reply the model cannot place clearly falls through
 * to what the script already did: an FAQ detour, or the clarification line.
 */

/** A script is deterministic by design, so the model must be clearly sure before it moves one. */
export const SCRIPT_DECISION_THRESHOLD = 0.7;

const DESCRIPTION_LIMIT = 1_900;
type ScriptNode = ScriptGraph['nodes'][number];

export interface ScriptDecision {
  request: DecisionRequest;
  /** Option key to the node it leads to. */
  targets: ReadonlyMap<string, string>;
}

/** Undefined when the node has no text transition to choose among. */
export function scriptDecisionRequest(
  node: ScriptNode,
  state: Record<string, unknown>,
): ScriptDecision | undefined {
  const matches = new Map<string, string[]>();
  for (const transition of node.transitions)
    if (transition.event === 'text')
      matches.set(transition.to, [...(matches.get(transition.to) ?? []), ...transition.matches]);
  if (!matches.size) return undefined;
  const criteria: Record<string, string> = {};
  const targets = new Map<string, string>();
  [...matches].forEach(([to, said], index) => {
    const key = `option_${index + 1}`;
    criteria[key] = bounded(
      `The caller's reply means the same as ${said.map((text) => `"${text}"`).join(' or ')}`,
    );
    targets.set(key, to);
  });
  criteria[FLOW_OTHER_INTENT] = FLOW_OTHER_DESCRIPTION;
  return {
    request: {
      state,
      questions: {
        [FLOW_INTENT_QUESTION]: {
          type: 'choice',
          instructions: bounded(
            `The agent said: "${node.prompt}" Which option does \`caller_reply\` mean?`,
          ),
          criteria,
        },
      },
    },
    targets,
  };
}

/** The node a clear answer leads to, or undefined for `other`, low confidence or a bad answer. */
export function scriptDecisionTarget(
  decision: ScriptDecision,
  response: unknown,
): string | undefined {
  try {
    const { response: valid } = validateDecisionExchange(decision.request, response);
    const answer = valid.answers[FLOW_INTENT_QUESTION];
    if (answer?.type !== 'choice' || answer.confidence < SCRIPT_DECISION_THRESHOLD)
      return undefined;
    return decision.targets.get(answer.choice);
  } catch {
    // swallow-ok: an answer that does not fit the question is no answer; the script's own fallback runs.
    return undefined;
  }
}

function bounded(text: string): string {
  return text.length > DESCRIPTION_LIMIT ? `${text.slice(0, DESCRIPTION_LIMIT)}…` : text;
}
