import { z } from 'zod';
import { RoutingHours } from '../routing/hours.ts';
import { RouteLines, RouteUuid, RouteVariableName, RoutingKey } from '../routing/ids.ts';
import { HoldPolicy } from '../routing/transfer.ts';
import { DestinationPolicy, WebhookSpec } from './webhook.ts';

/**
 * Wave 17 (R3) human queues: a workspace entity (defined once, like a pool) that a routing point
 * binds by key and a release pins by value. Two kinds: `external` (a third-party ACD reached by a
 * signed webhook, then a carrier transfer) and `managed` (an OVO operator desk, bridged by a room).
 */
export const HUMAN_QUEUE_LIMITS = Object.freeze({
  queuesPerPoint: 10,
  maxWaiting: 500,
  teams: 20,
  returnTargets: 10,
  variables: 20,
  transcriptTurns: 20,
  contextRetentionHoursMax: 720,
});
const Name = z.string().trim().min(1).max(120);
export const OperatorTeam = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

/** What a queue may know about the call. A mapping or a desk panel can read nothing the policy leaves off. */
export const QueueContextPolicy = z
  .object({
    /** E.164 caller (`caller.number`). */
    callerId: z.boolean(),
    /** The dialled number (`caller.calledNumber`). */
    calledNumber: z.boolean(),
    /** `route.language`. */
    language: z.boolean(),
    /** Route context values (`route.intent`, `route.path`, `route.context.*`). */
    intent: z.boolean(),
    /** The transferring agent's summary and reason (`handover.summary|reason`). */
    summary: z.boolean(),
    transcriptTurns: z.number().int().min(0).max(HUMAN_QUEUE_LIMITS.transcriptTurns),
    /** A signed read-only link (`ticket.transcriptUrl`). */
    transcriptLink: z.boolean(),
    /** `declared`: the captured variables the transferring agent's schema declares (managed only). Else an allow-list. */
    variables: z.union([
      z.literal('declared'),
      z.array(RouteVariableName).max(HUMAN_QUEUE_LIMITS.variables),
    ]),
    /** `agent_only`: the transferring LLM's summary. `generate` (P2): one bounded LLM call while the announcement plays. */
    summarize: z.enum(['agent_only', 'generate']),
  })
  .strict();
export type QueueContextPolicy = z.infer<typeof QueueContextPolicy>;
export const EXTERNAL_CONTEXT_DEFAULT: QueueContextPolicy = {
  callerId: false,
  calledNumber: false,
  language: true,
  intent: true,
  summary: true,
  transcriptTurns: 0,
  transcriptLink: true,
  variables: [],
  summarize: 'agent_only',
};
export const MANAGED_CONTEXT_DEFAULT: QueueContextPolicy = {
  callerId: true,
  calledNumber: true,
  language: true,
  intent: true,
  summary: true,
  transcriptTurns: 6,
  transcriptLink: false,
  variables: 'declared',
  summarize: 'agent_only',
};

const Base = {
  name: Name,
  description: z.string().max(2_000).optional(),
  /** Absent: always open. Closed: the handoff is refused `queue_closed` before anything is announced. */
  hours: RoutingHours.optional(),
  /** Spoken by the requester before the hold. Absent: the point's, else `TRANSFER_BUILT_IN_LINES.human`. */
  announcement: RouteLines.optional(),
  /** The wait: steps, `maxSeconds` (5-900, the whole wait), `onTimeout` chain. Absent: target, point, then `DEFAULT_QUEUE_HOLD_POLICY`. */
  hold: HoldPolicy.optional(),
  limits: z
    .object({
      /** Tickets waiting or offered in this queue; past it `begin` refuses `queue_full`. */
      maxWaiting: z.number().int().min(1).max(HUMAN_QUEUE_LIMITS.maxWaiting).default(100),
    })
    .strict()
    .default({ maxWaiting: 100 }),
};

export const ExternalQueue = z
  .object({
    kind: z.literal('external'),
    ...Base,
    webhook: WebhookSpec,
    destination: DestinationPolicy,
    context: QueueContextPolicy.default(EXTERNAL_CONTEXT_DEFAULT),
    /** How long `released`/`outcome` callbacks are still accepted after the leg was handed on. */
    callbackWindowHours: z.number().int().min(1).max(168).default(24),
  })
  .strict();
export type ExternalQueue = z.infer<typeof ExternalQueue>;

export const ManagedQueue = z
  .object({
    kind: z.literal('managed'),
    ...Base,
    /** `OPEN_PICKUP`: every eligible online operator sees the ticket; first accept wins. `AUTO_ASSIGN`: OVO offers it to one operator at a time. */
    assignment: z.enum(['AUTO_ASSIGN', 'OPEN_PICKUP']).default('OPEN_PICKUP'),
    /** Operators with any of these teams (empty: every enabled operator). */
    teamIds: z.array(OperatorTeam).max(HUMAN_QUEUE_LIMITS.teams).default([]),
    /** Match the call's language to `operator.languages`: ignore, prefer (order only), require (eligibility). */
    language: z.enum(['ignore', 'prefer', 'require']).default('prefer'),
    /** AUTO_ASSIGN offer expiry (`HumanHandoffRequest.acceptTimeoutMs`). */
    offerSeconds: z.number().int().min(5).max(120).default(20),
    /** From accept to the operator being in the room; past it the ticket is re-offered (`operator_no_show`). */
    joinSeconds: z.number().int().min(5).max(120).default(25),
    /** Precheck: refuse `no_operators` when nobody eligible is online with room. Off: the caller waits regardless. */
    requireOnline: z.boolean().default(true),
    /** `out`: the AI is gone. `transcribe`: the router release's STT runs silently for captions and the transcript. */
    ai: z
      .object({
        mode: z.enum(['out', 'transcribe']).default('transcribe'),
        transcribeOperator: z.boolean().default(true),
      })
      .strict()
      .default({ mode: 'transcribe', transcribeOperator: true }),
    /** The operator closes the desk without a command: end the call, or return the caller to `returnDefault`. */
    onOperatorLeave: z.enum(['end_call', 'return_to_agent']).default('end_call'),
    /** Catalogue transfer keys (`RoutingTransferPolicy.targets[].key`) the operator may send the caller to. */
    returnTargets: z.array(RoutingKey).max(HUMAN_QUEUE_LIMITS.returnTargets).default([]),
    returnDefault: RoutingKey.optional(),
    wrapUp: z
      .object({
        required: z.boolean().default(false),
        dispositions: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
      })
      .strict()
      .default({ required: false, dispositions: [] }),
    context: QueueContextPolicy.default(MANAGED_CONTEXT_DEFAULT),
  })
  .strict();
export type ManagedQueue = z.infer<typeof ManagedQueue>;

export const HumanQueueDefinition = z.discriminatedUnion('kind', [ExternalQueue, ManagedQueue]);
export type HumanQueueDefinition = z.infer<typeof HumanQueueDefinition>;

export interface HumanQueue {
  id: string;
  workspaceId: string;
  definition: HumanQueueDefinition;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

/** A queue as frozen into a routing release. Staffing (operators) is live and not part of it. */
export const QueueSnapshot = z
  .object({
    id: RouteUuid,
    version: z.number().int().positive(),
    key: RoutingKey,
    priority: z.number().int().min(0).max(9),
    definition: HumanQueueDefinition,
  })
  .strict();
export type QueueSnapshot = z.infer<typeof QueueSnapshot>;

/** The binding in a draft: a local key (what `human` steps and targets name) to a workspace queue. */
export const HumanQueueBinding = z
  .object({
    key: RoutingKey,
    queueId: RouteUuid,
    priority: z.number().int().min(0).max(9).default(0),
  })
  .strict();
export type HumanQueueBinding = z.infer<typeof HumanQueueBinding>;
