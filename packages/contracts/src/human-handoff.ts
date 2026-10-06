import { z } from 'zod';

/** Port shared by an in-process open-pickup queue and an optional external assignment service. */
const Id = z.string().min(1).max(200);
export const HumanPresence = z
  .object({
    operatorId: Id,
    status: z.enum(['AVAILABLE', 'AWAY', 'OFFLINE']),
    capacity: z.number().int().min(0).max(100),
    activeAssignments: z.number().int().min(0).max(100),
    teamIds: z.array(Id).max(100),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .refine((presence) => presence.activeAssignments <= presence.capacity, {
    message: 'Active assignments cannot exceed capacity',
  });
export type HumanPresence = z.infer<typeof HumanPresence>;

export const HumanHandoffRequest = z
  .object({
    workspaceId: Id,
    sessionId: Id,
    /** Stable across retries so two hosts cannot open duplicate assignments. */
    idempotencyKey: Id,
    queueId: Id,
    mode: z.enum(['AUTO_ASSIGN', 'OPEN_PICKUP']),
    summary: z.string().max(4_000),
    context: z.record(z.string(), z.unknown()).default({}),
    acceptTimeoutMs: z.number().int().min(1_000).max(300_000),
  })
  .strict();
export type HumanHandoffRequest = z.infer<typeof HumanHandoffRequest>;

export const HumanHandoffTicket = z
  .object({
    id: Id,
    workspaceId: Id,
    sessionId: Id,
    queueId: Id,
    status: z.enum(['waiting', 'offered', 'accepted', 'released', 'expired']),
    version: z.number().int().positive(),
    assignedOperatorId: Id.optional(),
  })
  .strict()
  .superRefine((ticket, ctx) => {
    if (ticket.status === 'accepted' && !ticket.assignedOperatorId)
      ctx.addIssue({ code: 'custom', message: 'Accepted handoff needs an operator' });
    if (ticket.status === 'waiting' && ticket.assignedOperatorId)
      ctx.addIssue({ code: 'custom', message: 'Waiting handoff cannot already be assigned' });
  });
export type HumanHandoffTicket = z.infer<typeof HumanHandoffTicket>;

export const HumanHandoffAccept = z
  .object({
    workspaceId: Id,
    ticketId: Id,
    operatorId: Id,
    expectedVersion: z.number().int().positive(),
    idempotencyKey: Id,
  })
  .strict();
export type HumanHandoffAccept = z.infer<typeof HumanHandoffAccept>;

export const HumanHandoffRelease = z
  .object({
    workspaceId: Id,
    ticketId: Id,
    expectedVersion: z.number().int().positive(),
    reason: z.enum(['completed', 'declined', 'timed_out', 'call_ended']),
    idempotencyKey: Id,
  })
  .strict();
export type HumanHandoffRelease = z.infer<typeof HumanHandoffRelease>;

export interface HumanHandoffPort {
  request(input: HumanHandoffRequest): Promise<HumanHandoffTicket>;
  presence(input: { workspaceId: string; queueId: string }): Promise<readonly HumanPresence[]>;
  /** First eligible claimant wins; a stale version must be refused. */
  accept(input: HumanHandoffAccept): Promise<HumanHandoffTicket | { kind: 'conflict' }>;
  release(input: HumanHandoffRelease): Promise<HumanHandoffTicket | { kind: 'conflict' }>;
}

/*
 * AGT-15: what an agent does to hand a call to a person, or to promise one later. The agent only
 * decides; the host carries a transfer out through the carrier (`TelephonyControl.handoff`, behind
 * `HumanHandoffPort`) once the agent's last line has played, and the API keeps callbacks durable.
 */

const Line = z.string().trim().min(1).max(1_000);
/** A flow node id; the flow grammar (`agent-flow.ts`). */
const NodeKey = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/);

/** The tool the LLM calls to hand the caller to a person. Reserved when offered. */
export const TRANSFER_CALL_TOOL_ID = 'transfer_call';
/** The tool the LLM calls to promise a call back. Reserved when offered. */
export const SCHEDULE_CALLBACK_TOOL_ID = 'schedule_callback';
/**
 * An agent's completion reason with this prefix ends the call `transferred` rather than
 * `behavior_completed`: the host hands the carrier leg on instead of hanging it up.
 */
export const TRANSFER_REASON_PREFIX = 'transfer:';
export const DEFAULT_TRANSFER_LINE = 'Please hold while I connect you to a colleague.';

/** Where a transfer goes. The carrier's `capabilities.control.handoff` must list the kind. */
export const AgentTransferTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('phone'), e164: z.string().regex(/^\+[1-9][0-9]{5,14}$/) }).strict(),
  // A carrier queue name: printable ASCII, at most 200 characters.
  z.object({ kind: z.literal('queue'), name: z.string().regex(/^[\x20-\x7e]{1,200}$/) }).strict(),
]);
export type AgentTransferTarget = z.infer<typeof AgentTransferTarget>;

/**
 * When the agent hands the caller to a person. Every trigger is off by default, so a target alone
 * changes nothing until a flow node, a fallback or the LLM tool is pointed at it.
 */
export const AgentTransfer = z
  .object({
    target: AgentTransferTarget,
    /** Spoken before a transfer that has no node lines of its own (a fallback, the LLM tool). */
    line: Line.default(DEFAULT_TRANSFER_LINE),
    /** Flow end nodes that transfer once their lines have played, instead of hanging up. */
    nodes: z.array(NodeKey).max(20).default([]),
    /** The decision model is unavailable on a turn: transfer instead of re-asking or the LLM. */
    onDecisionUnavailable: z.boolean().default(false),
    /** Re-asks ran out (`recovery.maxAttempts`): transfer instead of the give-up line. */
    onRecoveryExhausted: z.boolean().default(false),
    /** Offer the LLM a built-in `transfer_call` tool. */
    llmTool: z.boolean().default(false),
  })
  .strict();
export type AgentTransfer = z.infer<typeof AgentTransfer>;

/** When to call back: after a delay, or at a local time today or tomorrow (agent timezone). */
export const CallbackWhen = z.union([
  z.object({ inMinutes: z.number().int().min(5).max(43_200) }).strict(),
  z
    .object({
      at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      day: z.enum(['today', 'tomorrow']).default('today'),
    })
    .strict(),
]);
export type CallbackWhen = z.infer<typeof CallbackWhen>;

/**
 * Promised callbacks. Each is recorded on the call as a `disposition` event carrying a `callback`
 * field (`CallbackRequest`), which the API keeps as a durable callback an operator can dial.
 */
export const AgentCallback = z
  .object({
    /** Flow nodes that schedule a callback on entry ("I'll call you back this evening"). */
    nodes: z.record(NodeKey, CallbackWhen).default({}),
    /** Used when the LLM names no time, and as the floor when a named time has already passed. */
    defaultDelayMinutes: z.number().int().min(5).max(10_080).default(120),
    /** Offer the LLM a built-in `schedule_callback` tool. */
    llmTool: z.boolean().default(false),
  })
  .strict();
export type AgentCallback = z.infer<typeof AgentCallback>;

export const AgentHandoff = z
  .object({
    transfer: AgentTransfer.optional(),
    callback: AgentCallback.optional(),
  })
  .strict();
export type AgentHandoff = z.infer<typeof AgentHandoff>;

/** The `callback` field of a `disposition` event: what was promised, and when it falls due. */
export const CallbackRequest = z
  .object({
    dueAt: z.iso.datetime({ offset: true }),
    timezone: z.string().min(1).max(100),
    source: z.enum(['flow', 'llm']),
    /** The node that promised it, for a flow callback. */
    node: NodeKey.optional(),
    /** What the caller asked for, as configured or as the LLM passed it. */
    requested: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    reason: z.string().max(200).optional(),
  })
  .strict();
export type CallbackRequest = z.infer<typeof CallbackRequest>;

/**
 * Every handoff line an agent can speak, with its config path: for template checks and the clip
 * inventory. The transfer line is spoken only by a fallback that transfers.
 */
export function agentHandoffLines(config: {
  handoff?: AgentHandoff;
}): { field: string; text: string }[] {
  const transfer = config.handoff?.transfer;
  return transfer && (transfer.onDecisionUnavailable || transfer.onRecoveryExhausted)
    ? [{ field: 'handoff.transfer.line', text: transfer.line }]
    : [];
}

/** Agent config issues a handoff block raises against the rest of the config, by path. */
export function handoffIssues(config: {
  handoff?: AgentHandoff;
  tools: readonly { id: string }[];
  decision?: { flow?: { nodes: readonly { id: string; end: boolean }[] } };
}): { path: (string | number)[]; message: string }[] {
  const handoff = config.handoff;
  if (!handoff) return [];
  const issues: { path: (string | number)[]; message: string }[] = [];
  const nodes = new Map((config.decision?.flow?.nodes ?? []).map((node) => [node.id, node]));
  handoff.transfer?.nodes.forEach((id, index) => {
    const node = nodes.get(id);
    if (!node)
      issues.push({
        path: ['handoff', 'transfer', 'nodes', index],
        message: `Transfer node ${id} is not a flow node`,
      });
    else if (!node.end)
      issues.push({
        path: ['handoff', 'transfer', 'nodes', index],
        message: `Transfer node ${id} must end the call (end: true)`,
      });
  });
  for (const id of Object.keys(handoff.callback?.nodes ?? {}))
    if (!nodes.has(id))
      issues.push({
        path: ['handoff', 'callback', 'nodes', id],
        message: `Callback node ${id} is not a flow node`,
      });
  const reserved = [
    ...(handoff.transfer?.llmTool ? [TRANSFER_CALL_TOOL_ID] : []),
    ...(handoff.callback?.llmTool ? [SCHEDULE_CALLBACK_TOOL_ID] : []),
  ];
  for (const id of reserved)
    if (config.tools.some((tool) => tool.id === id))
      issues.push({ path: ['tools'], message: `Tool id ${id} is reserved for handoff` });
  return issues;
}
