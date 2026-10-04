import type { CompatRule } from './types.ts';
import { issue } from './types.ts';
/** A selected knowledge plugin nothing queries adds a slot to every release for no effect. */
export const knowledgePluginUnused: CompatRule = (input, stage) =>
  input.selections?.knowledge && !input.config.knowledge?.enabled
    ? [
        issue(
          'knowledge_plugin_unused',
          stage,
          `${input.selections.knowledge.pluginId} is selected, but grounding is not enabled`,
          { slot: 'knowledge' },
          'warning',
        ),
      ]
    : [];
