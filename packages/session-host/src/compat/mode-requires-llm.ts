import { agentLlmPaths } from '@winsendotai/ovo-contracts';
import type { CompatRule } from './types.ts';
import { issue } from './types.ts';

/**
 * A reachability check, not a mode check (AGT-4): an LLM is required only when some configured
 * path can reach it. A Jev-only agent, whose decision policy, rules and recovery lines answer every
 * turn, publishes without one.
 */
export const modeRequiresLlm: CompatRule = (input, stage) => {
  if (input.selections?.llm) return [];
  const paths = agentLlmPaths(input.config);
  if (!paths.length) return [];
  const message =
    input.config.mode === 'agent'
      ? `This agent can reach the LLM (${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ', …' : ''}), so it requires one; answer those paths with lines to run it Jev-only`
      : `${input.config.mode} mode requires an LLM`;
  return [issue('mode_requires_llm', stage, message, { slot: 'llm', field: paths[0] })];
};
