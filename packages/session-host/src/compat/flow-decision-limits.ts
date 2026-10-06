import type { AgentConfig, DecisionCapabilities } from '@winsendotai/ovo-contracts';
import { manifestKeys } from '@winsendotai/ovo-runtime';
import type { CompatInput, CompatRule } from './types.ts';
import { issue, resolved } from './types.ts';

/** One request the flow or script can send: where it is authored, and each choice's size. */
interface Asked {
  field: string;
  choices: number[];
}

/**
 * `decision-primitive-unsupported.ts` for the requests a flow or a script sends. Every one is choice
 * questions: the listen set's intents with the globals and `other`, plus one per slot. A listen set
 * larger than the selected model accepts would fail on the turn that reaches it, mid-call.
 */
export const flowDecisionLimits: CompatRule = (input, stage) => {
  const asked = requests(input.config);
  const model = asked.length ? decisionModel(input) : undefined;
  if (!model) return [];
  const { pluginId, limits } = model;
  const refuse = (field: string, message: string) =>
    issue('decision_primitive_unsupported', stage, message, { slot: 'decision', pluginId, field });
  if (!limits.primitives.includes('choice'))
    return [refuse('decision', `${pluginId} does not answer the choice questions a flow asks`)];
  const found = [];
  for (const { field, choices } of asked) {
    const widest = Math.max(...choices);
    if (limits.maxCriteria > 0 && widest > limits.maxCriteria)
      found.push(
        refuse(field, `${field} offers ${widest} options; ${pluginId} takes ${limits.maxCriteria}`),
      );
    const perRequest = limits.maxQuestionsPerRequest;
    if (perRequest > 0 && choices.length > perRequest)
      found.push(
        refuse(
          field,
          `${field} asks ${choices.length} questions at once; the limit is ${perRequest}`,
        ),
      );
  }
  return found;
};

function decisionModel(
  input: CompatInput,
): { pluginId: string; limits: DecisionCapabilities } | undefined {
  const selected = resolved(input).find((entry) => entry.slot === 'decision');
  const limits = selected
    ? (manifestKeys(selected.definition.manifest).manifest.capabilities as
        DecisionCapabilities | undefined)
    : undefined;
  return selected && limits?.primitives
    ? { pluginId: selected.choice.pluginId, limits }
    : undefined;
}

function requests(config: AgentConfig): Asked[] {
  const policy = config.decision;
  if (!policy?.enabled) return [];
  if (policy.flow) {
    const globals = policy.flow.globalIntents.length;
    return policy.flow.listens.map((listen, index) => ({
      field: `decision.flow.listens.${index}`,
      choices: [
        listen.intents.length + globals + 1,
        ...listen.slots.map((slot) => slot.options.length),
      ],
    }));
  }
  // A script with questions does not ask the model (`flow-mode.ts`), as before script decisions.
  if (config.mode === 'agent' || !config.script || policy.questions.length) return [];
  return config.script.nodes.flatMap((node, index) => {
    const targets = new Set(
      node.transitions.filter((edge) => edge.event === 'text').map((edge) => edge.to),
    );
    return targets.size ? [{ field: `script.nodes.${index}`, choices: [targets.size + 1] }] : [];
  });
}
