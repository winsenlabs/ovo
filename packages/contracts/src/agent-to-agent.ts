import { z } from 'zod';

/** A fixed handoff line (AGT-15 and R2). */
export const HandoffLine = z.string().trim().min(1).max(1_000);
/** A flow node id; the flow grammar (`agent-flow.ts`). */
export const HandoffNodeKey = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/);
const Line = HandoffLine;

/** The tool the LLM calls to hand the caller to another agent (R2). Reserved when offered. */
export const TRANSFER_TO_AGENT_TOOL_ID = 'transfer_to_agent';
/** A transfer catalogue key on the call's routing point (`TransferTarget.key`). */
const TargetKey = HandoffNodeKey;

/**
 * R2: this agent's side of an in-call transfer to another agent on the same call. The targets
 * themselves live on the routing point (pinned in its release); the agent only opts in, says its
 * own transfer line, and decides how it greets a caller transferred to it. Inert on a call that
 * is not routed (no `ovo.agent-transfer` capability).
 */
export const AgentToAgentTransfer = z
  .object({
    /** Offer `transfer_to_agent` with the targets the call's routing point grants this agent. */
    llmTool: z.boolean().default(false),
    /** Flow end nodes that transfer to a target key once their lines have played. */
    nodes: z.record(HandoffNodeKey, TargetKey).default({}),
    /** Said before this agent's transfers unless the point's target authors one. Fixed; pre-rendered. */
    line: Line.optional(),
    /** When this agent receives a transferred call. */
    inbound: z
      .object({
        /** `opening`: its usual opening. `line`: `line` below. `llm`: one LLM greeting using the handover. */
        greeting: z.enum(['opening', 'line', 'llm']).default('opening'),
        /** Templated like an opening line (declared variables and `ovo_route_*`). Required for `line`. */
        line: Line.optional(),
        /** Said when a failed transfer returns the caller here. Absent: built-in en/hi `returned`. */
        returnLine: Line.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AgentToAgentTransfer = z.infer<typeof AgentToAgentTransfer>;

/** R2: fixed lines of `handoff.agents`, for the clip inventory and template checks. */
export function agentTransferLines(config: {
  handoff?: { agents?: AgentToAgentTransfer };
}): { field: string; text: string }[] {
  const agents = config.handoff?.agents;
  if (!agents) return [];
  const lines: { field: string; text: string }[] = [];
  if (agents.line) lines.push({ field: 'handoff.agents.line', text: agents.line });
  if (agents.inbound?.line)
    lines.push({ field: 'handoff.agents.inbound.line', text: agents.inbound.line });
  if (agents.inbound?.returnLine)
    lines.push({ field: 'handoff.agents.inbound.returnLine', text: agents.inbound.returnLine });
  return lines;
}
