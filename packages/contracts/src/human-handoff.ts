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
