import type { CompatRule } from './types.ts';
import { issue } from './types.ts';
export const modeLlmUnused: CompatRule = (input, stage) =>
  (input.config.mode === 'announcement' || input.config.mode === 'faq') && !!input.selections?.llm
    ? [
        issue(
          'mode_llm_unused',
          stage,
          `${input.config.mode} mode does not use the selected LLM`,
          { slot: 'llm' },
          'warning',
        ),
      ]
    : [];
