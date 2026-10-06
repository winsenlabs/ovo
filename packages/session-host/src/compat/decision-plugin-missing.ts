import type { CompatRule } from './types.ts';
import { issue } from './types.ts';
/** An enabled policy with no decision plugin would run the whole call on the LLM fallback. */
export const decisionPluginMissing: CompatRule = (input, stage) => {
  const policy = input.config.decision;
  if (!policy?.enabled || input.selections?.decision) return [];
  const count = policy.questions.length;
  const what = policy.flow
    ? 'a decision flow'
    : `${count} decision question${count === 1 ? '' : 's'}`;
  return [
    issue(
      'decision_plugin_missing',
      stage,
      `${input.config.name} configures ${what}, but no decision plugin is selected`,
      { slot: 'decision' },
    ),
  ];
};
