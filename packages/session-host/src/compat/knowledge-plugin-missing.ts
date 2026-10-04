import type { CompatRule } from './types.ts';
import { issue } from './types.ts';
/** An enabled policy with no knowledge plugin would answer ungrounded, or refuse every turn. */
export const knowledgePluginMissing: CompatRule = (input, stage) =>
  input.config.knowledge?.enabled && !input.selections?.knowledge
    ? [
        issue(
          'knowledge_plugin_missing',
          stage,
          `${input.config.name} configures grounding, but no knowledge plugin is selected`,
          { slot: 'knowledge' },
        ),
      ]
    : [];
