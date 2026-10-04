import type { CompatRule } from './types.ts';
import { issue } from './types.ts';
/** A selected, metered decision plugin that nothing asks is cost and latency for nothing. */
export const decisionPluginUnused: CompatRule = (input, stage) =>
  input.selections?.decision && !input.config.decision?.enabled
    ? [
        issue(
          'decision_plugin_unused',
          stage,
          `${input.selections.decision.pluginId} is selected, but no decision question is enabled`,
          { slot: 'decision' },
          'warning',
        ),
      ]
    : [];
