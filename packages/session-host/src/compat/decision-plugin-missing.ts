import type { CompatRule } from './types.ts';
import { issue } from './types.ts';
/** An enabled policy with no decision plugin would run the whole call on the LLM fallback. */
export const decisionPluginMissing: CompatRule = (input, stage) =>
  input.config.decision?.enabled && !input.selections?.decision
    ? [
        issue(
          'decision_plugin_missing',
          stage,
          `${input.config.name} configures ${input.config.decision.questions.length} decision question${input.config.decision.questions.length === 1 ? '' : 's'}, but no decision plugin is selected`,
          { slot: 'decision' },
        ),
      ]
    : [];
