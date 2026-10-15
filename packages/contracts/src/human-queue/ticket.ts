import { z } from 'zod';
import { RouteLanguage, RouteUuid, RoutingKey } from '../routing/ids.ts';
import { OperatorTeam } from './queue.ts';

/**
 * The durable ticket a human handoff runs on, and the operator-facing shapes around it. The worker
 * (which holds the call), the API (which serves operators) and the dispatcher's sweeper (which
 * assigns and expires) meet in this row; `HumanHandoffTicket.status` is the same state set.
 */
export const TICKET_STATES = ['waiting', 'offered', 'accepted', 'released', 'expired'] as const;
export type TicketState = (typeof TICKET_STATES)[number];
/** Why a ticket ended. The port's `HumanHandoffRelease.reason` keeps its four values; this is the stored code. */
export const TICKET_RELEASE_CODES = [
  'completed',
  'declined',
  'timed_out',
  'call_ended',
  'operator_no_show',
  'handed_off',
  'abandoned',
  'queue_changed',
  'worker_lost',
  'webhook_rejected',
  'webhook_failed',
  'operator_left',
  'returned',
  'ended_by_operator',
  'room_lost',
] as const;
export type TicketReleaseCode = (typeof TICKET_RELEASE_CODES)[number];
export const TICKET_OUTCOMES = [
  'connected',
  'handed_off',
  'returned',
  'ended',
  'abandoned',
  'timeout',
  'rejected',
  'unavailable',
  'failed',
  'caller_hangup',
] as const;
export type TicketOutcome = (typeof TICKET_OUTCOMES)[number];
export const OPERATOR_STATUSES = ['AVAILABLE', 'AWAY', 'OFFLINE'] as const;
export type OperatorStatus = (typeof OPERATOR_STATUSES)[number];
export const QUEUE_KINDS = ['external', 'managed'] as const;
export const ASSIGNMENT_MODES = ['AUTO_ASSIGN', 'OPEN_PICKUP'] as const;

const Name = z.string().trim().min(1).max(120);

/** The operator-facing row. Caller numbers are masked here; the full number is in `TicketContext` after accept. */
export const HumanTicketView = z
  .object({
    id: RouteUuid,
    queueId: RouteUuid,
    queueKey: RoutingKey,
    queueName: Name,
    kind: z.enum(QUEUE_KINDS),
    mode: z.enum(ASSIGNMENT_MODES),
    status: z.enum(TICKET_STATES),
    version: z.number().int().positive(),
    priority: z.number().int().min(0).max(9),
    language: RouteLanguage.optional(),
    callerMasked: z.string().max(40).optional(),
    createdAt: z.iso.datetime(),
    waitMs: z.number().int().nonnegative(),
    offeredToMe: z.boolean(),
    offerExpiresAt: z.iso.datetime().optional(),
    assignedOperatorId: z.string().max(200).optional(),
    connectedAt: z.iso.datetime().optional(),
    releasedAt: z.iso.datetime().optional(),
    releaseCode: z.enum(TICKET_RELEASE_CODES).optional(),
  })
  .strict();
export type HumanTicketView = z.infer<typeof HumanTicketView>;

/** Sensitive; returned only to the assigned operator (managed) or by token (external), scrubbed after retention. */
export const TicketContext = z
  .object({
    callId: z.string().max(200),
    /** A deterministic one line from route context, never LLM text. */
    brief: z.string().max(400),
    /** The transferring agent's own summary: untrusted text. */
    summary: z.string().max(1_000).optional(),
    reason: z.string().max(200).optional(),
    language: RouteLanguage.optional(),
    intent: z.string().max(80).optional(),
    routePath: z.array(RoutingKey).max(32),
    caller: z
      .object({
        number: z.string().max(32).optional(),
        calledNumber: z.string().max(32).optional(),
      })
      .strict(),
    transcript: z
      .array(z.object({ role: z.enum(['caller', 'agent']), text: z.string().max(500) }).strict())
      .max(40),
    variables: z.record(
      z.string().max(64),
      z.union([z.string().max(500), z.number(), z.boolean()]),
    ),
    fromAgent: z
      .object({ agentId: z.string().max(200), releaseId: RouteUuid })
      .strict()
      .optional(),
    returnTargets: z
      .array(z.object({ key: RoutingKey, label: z.string().max(120) }).strict())
      .max(10),
  })
  .strict();
export type TicketContext = z.infer<typeof TicketContext>;

export const OperatorProfile = z
  .object({
    userId: z.string().min(1).max(200),
    displayName: z.string().max(120),
    enabled: z.boolean(),
    teamIds: z.array(OperatorTeam).max(20),
    languages: z.array(RouteLanguage).max(12),
    capacity: z.number().int().min(0).max(20),
  })
  .strict();
export type OperatorProfile = z.infer<typeof OperatorProfile>;

/** A short-TTL, room-scoped join grant minted by the API at accept. */
export const RoomGrant = z
  .object({
    provider: z.string().max(40),
    serverUrl: z.url().max(512),
    roomName: z.string().max(128),
    identity: z.string().max(128),
    role: z.enum(['operator', 'monitor']),
    token: z.string().max(4_096),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type RoomGrant = z.infer<typeof RoomGrant>;
export const DeskAcceptResult = z
  .object({ ticket: HumanTicketView, room: RoomGrant, context: TicketContext })
  .strict();
export type DeskAcceptResult = z.infer<typeof DeskAcceptResult>;

/** Operator commands. The API validates, stores on the ticket, bumps `command_seq`; the worker executes and acks. */
export const DeskCommand = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('end_call') }).strict(),
  /** `target` must be in the queue's `returnTargets`. */
  z.object({ kind: z.literal('return_to_agent'), target: RoutingKey }).strict(),
]);
export type DeskCommand = z.infer<typeof DeskCommand>;
export const WrapUp = z
  .object({
    disposition: z.string().trim().min(1).max(60).optional(),
    note: z.string().max(1_000).optional(),
  })
  .strict();
export type WrapUp = z.infer<typeof WrapUp>;
/** Room data channel, topic `ovo.caption`: worker to the operator only. */
export const CaptionMessage = z
  .object({
    role: z.enum(['caller', 'operator', 'agent']),
    text: z.string().max(500),
    final: z.boolean(),
    at: z.number().int().nonnegative(),
  })
  .strict();
export type CaptionMessage = z.infer<typeof CaptionMessage>;
export const CAPTION_TOPIC = 'ovo.caption';
export const DTMF_TOPIC = 'ovo.dtmf';

/**
 * The room a managed ticket is answered in: deterministic, unguessable (the ticket id is a random
 * uuid). Each accept uses its own room, named with the ticket version the accept produces
 * (`expectedVersion + 1`): after a no-show re-offer the first operator's token, still valid for its
 * TTL, opens a room nobody bridges, not the second operator's call. Without a generation: the room
 * of the first design, which a caller that predates it still mints.
 */
export const humanRoomName = (ticketId: string, generation?: number): string =>
  generation === undefined ? `ovo-hq-${ticketId}` : `ovo-hq-${ticketId}-${generation}`;
