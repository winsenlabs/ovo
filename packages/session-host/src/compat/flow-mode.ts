import { flowIssue } from './flow-issue.ts';
import type { CompatRule } from './types.ts';

/**
 * AGT-14: a decision policy that a mode would silently ignore is refused, not released.
 *
 * Agent mode runs flat questions or a flow. A script (announcement or FAQ mode with `script`) uses
 * the decision model only to match replies to its own transitions, so its policy carries neither.
 * Any other mode never asks the decision model at all.
 *
 * A policy with questions outside agent mode is a shape releases published before flows could
 * carry, and they ran by ignoring it. Those still load and run: the issue blocks a new release and
 * is only a warning when an existing one is admitted to a call. A flow, or an empty question list,
 * could not be published before, so those block at every stage.
 */
export const flowMode: CompatRule = (input, stage) => {
  const { config } = input;
  const policy = config.decision;
  if (!policy?.enabled) return [];
  const refuse = (message: string, field = 'decision') =>
    flowIssue('decision_mode_unsupported', stage, message, { field });
  const ignored = (message: string, field: string) =>
    flowIssue(
      'decision_mode_unsupported',
      stage,
      message,
      { field },
      stage === 'release' ? 'error' : 'warning',
    );
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
  if (!config.script) {
    const message = `${config.mode} mode never asks the decision model; only agent mode and scripts use it`;
    return [policy.questions.length ? ignored(message, 'decision') : refuse(message)];
  }
  if (policy.questions.length)
    return [
      ignored(
        "In a script the decision model only matches replies to the script's transitions; its questions would be ignored",
        'decision.questions',
      ),
    ];
  return [];
};
