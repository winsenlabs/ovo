import { z } from 'zod';
import { TICKET_OUTCOMES, TICKET_RELEASE_CODES, TICKET_STATES } from '../human-queue/ticket.ts';
import { RouteLanguage, RouteUuid } from './ids.ts';

export const QUEUE_ACTIVITY_WINDOWS = ['24h', '7d'] as const;
const Count = z.number().int().nonnegative();
const Ms = z.number().nonnegative().nullable();

/**
 * `GET /v1/human-queues/:id/activity`: a window of tickets and what became of them. A ticket row
 * never carries a number, a summary or a context (those stay behind the desk and webhook paths).
 */
export const QueueActivity = z.object({
  queueId: RouteUuid,
  window: z.enum(QUEUE_ACTIVITY_WINDOWS),
  stats: z.object({
    created: Count,
    handled: Count,
    abandoned: Count,
    expired: Count,
    webhookFailed: Count,
    avgWaitMs: Ms,
    p95WaitMs: Ms,
    avgTalkMs: Ms,
    byOutcome: z.partialRecord(z.enum(TICKET_OUTCOMES), Count),
  }),
  /** Newest 50. */
  tickets: z
    .array(
      z.object({
        id: RouteUuid,
        callId: z.string().max(200),
        status: z.enum(TICKET_STATES),
        priority: z.number().int().min(0).max(9),
        language: RouteLanguage.optional(),
        createdAt: z.iso.datetime(),
        waitMs: Count,
        releasedAt: z.iso.datetime().optional(),
        releaseCode: z.enum(TICKET_RELEASE_CODES).optional(),
        outcome: z.enum(TICKET_OUTCOMES).optional(),
        operatorId: z.string().max(200).optional(),
      }),
    )
    .max(50),
});
export type QueueActivity = z.infer<typeof QueueActivity>;
