import { agentLlmPaths } from '@winsendotai/ovo-contracts';
import type { CompatRule } from './types.ts';
import { issue } from './types.ts';

export const modeLlmUnused: CompatRule = (input, stage) => {
  if (!input.selections?.llm || agentLlmPaths(input.config).length) return [];
  const message =
    input.config.mode === 'agent'
      ? 'This agent is Jev-only: no configured path reaches the selected LLM, so it is never asked'
      : `${input.config.mode} mode does not use the selected LLM`;
  return [issue('mode_llm_unused', stage, message, { slot: 'llm' }, 'warning')];
};
