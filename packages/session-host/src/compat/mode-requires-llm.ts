import type { CompatRule } from './types.ts';
import { issue } from './types.ts';
export const modeRequiresLlm: CompatRule = (input, stage) =>
  (input.config.mode === 'context' || input.config.mode === 'agent') && !input.selections?.llm
    ? [
        issue('mode_requires_llm', stage, `${input.config.mode} mode requires an LLM`, {
          slot: 'llm',
        }),
      ]
    : [];
