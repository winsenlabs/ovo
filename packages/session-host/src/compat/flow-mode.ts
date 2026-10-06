import { flowIssue } from './flow-issue.ts';
import type { CompatRule } from './types.ts';

/**
 * AGT-14: a decision policy that a mode would silently ignore is refused, not released.
 *
 * Agent mode runs flat questions or a flow. A script (announcement or FAQ mode with `script`) uses
 * the decision model only to match replies to its own transitions, so its policy carries neither.
 * Any other mode never asks the decision model at all.
 */
export const flowMode: CompatRule = (input, stage) => {
  const { config } = input;
  const policy = config.decision;
  if (!policy?.enabled) return [];
  const refuse = (message: string, field = 'decision') =>
    flowIssue('decision_mode_unsupported', stage, message, { field });
  if (config.mode === 'agent')
    return policy.flow || policy.questions.length
      ? []
      : [refuse('Agent decisions need either decision questions or a flow')];
  if (policy.flow)
    return [
      refuse(
        `A decision flow runs only in agent mode; ${config.mode} mode ignores it`,
        'decision.flow',
      ),
    ];
  if (!config.script)
    return [
      refuse(
        `${config.mode} mode never asks the decision model; only agent mode and scripts use it`,
      ),
    ];
  if (policy.questions.length)
    return [
      refuse(
        "In a script the decision model only matches replies to the script's transitions; its questions would be ignored",
        'decision.questions',
      ),
    ];
  return [];
};
