import { FLOW_RESUME_TOOL_ID, inspectFlow } from '@winsendotai/ovo-contracts';
import { flowIssue } from './flow-issue.ts';
import type { CompatRule } from './types.ts';

/**
 * The flow's graph rules (AGT-1), as release blockers: an unknown target, a node nothing reaches,
 * an intent the model could not tell from another, a line that does not exist. The draft saves
 * with these so a flow can be wired up step by step; it cannot be released until they are gone.
 * Warnings (a line nobody speaks, a listen set nobody uses) are shown but do not block.
 */
export const flowInvalid: CompatRule = (input, stage) => {
  const flow = input.config.decision?.flow;
  if (!flow) return [];
  const issues = inspectFlow(flow).map((found) =>
    flowIssue(
      'flow_invalid',
      stage,
      `decision.flow.${found.path}: ${found.message}`,
      { field: `decision.flow.${found.path}` },
      found.severity,
    ),
  );
  if (input.config.tools.some((tool) => tool.id === FLOW_RESUME_TOOL_ID))
    issues.push(
      flowIssue(
        'flow_invalid',
        stage,
        `Tool id ${FLOW_RESUME_TOOL_ID} is reserved for the LLM to hand the call back to the flow`,
        { field: 'tools' },
      ),
    );
  return issues;
};
