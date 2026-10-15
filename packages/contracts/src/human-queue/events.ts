import { z } from 'zod';
import { TICKET_OUTCOMES } from './ticket.ts';

/**
 * Payloads of the four `human.*` session events. Loose like every session event, and like the
 * `route.*` events they carry ids, keys, codes and timings only: never caller words, numbers,
 * summaries or destinations (those live in the ticket row, which is scrubbed).
 */
const Name = z.string().trim().min(1).max(200);
const Code = z.string().max(80);
const Ms = z.number().nonnegative();

export const HUMAN_SOURCES = ['router', 'llm', 'flow', 'fallback', 'chain'] as const;
export const HumanRequestedPayload = z.looseObject({
  /** The queue's binding key in the release. */
  queue: Name,
  queueId: Name,
  kind: z.enum(['external', 'managed']),
  ticket: Name.optional(),
  source: z.enum(HUMAN_SOURCES),
  result: z.enum(['accepted', 'refused']),
  /** A `HandoffBeginFailure` code (`queue_closed`, `no_operators`...). */
  refusal: Code.optional(),
  priority: z.number().int().min(0).max(9).optional(),
  /** The R2 transfer index when the queue was a catalogue target. */
  transfer: z.number().int().min(1).optional(),
});
export type HumanRequestedPayload = z.infer<typeof HumanRequestedPayload>;

export const HUMAN_STATES = [
  'waiting',
  'offered',
  'accepted',
  'connected',
  'released',
  'expired',
  'destination',
  'handed_off',
] as const;
export const HumanStatePayload = z.looseObject({
  ticket: Name,
  state: z.enum(HUMAN_STATES),
  version: z.number().int().positive().optional(),
  by: z.enum(['worker', 'operator', 'sweeper', 'callback', 'admin']),
  /** The operator's user id. */
  operator: Name.optional(),
  /** A release or refusal code. */
  code: Code.optional(),
  waitMs: Ms.optional(),
  /** A third party's callback (`accepted`, `released`, `outcome`...) the API recorded after the leg left. */
  callback: Code.optional(),
});
export type HumanStatePayload = z.infer<typeof HumanStatePayload>;

export const HumanWebhookPayload = z.looseObject({
  ticket: Name,
  attempt: z.number().int().min(1),
  outcome: z.enum([
    'delivered',
    'retry',
    'failed',
    'accepted',
    'queued',
    'rejected',
    'cancelled_sent',
  ]),
  status: z.number().int().min(0).max(999).optional(),
  ms: Ms,
  /** `timeout`, `transport`, `http_503`, `invalid`, `policy`, `oversize`, `redirect`, `destination_refused:<code>`. */
  reason: Code.optional(),
});
export type HumanWebhookPayload = z.infer<typeof HumanWebhookPayload>;

export const HumanCompletedPayload = z.looseObject({
  ticket: Name,
  queue: Name,
  kind: z.enum(['external', 'managed']),
  outcome: z.enum(TICKET_OUTCOMES),
  waitMs: Ms,
  talkMs: Ms.optional(),
  operator: Name.optional(),
  segment: z.number().int().nonnegative().optional(),
  /** The chain steps that ran. */
  steps: z.array(z.string().max(80)).max(8).optional(),
});
export type HumanCompletedPayload = z.infer<typeof HumanCompletedPayload>;

/** `CallOutcomeSummary.human`: the folded `human.*` events of a call. */
export interface CallOutcomeHuman {
  queueKey: string;
  queueId: string;
  kind: 'external' | 'managed';
  ticket: string;
  requested: number;
  connected: number;
  waitMs: number | null;
  talkMs: number | null;
  outcome: (typeof TICKET_OUTCOMES)[number] | null;
  operator: string | null;
  /** Third-party callbacks seen (external queues). */
  callbacks: { accepted: boolean; released: boolean; outcome: string | null };
}
