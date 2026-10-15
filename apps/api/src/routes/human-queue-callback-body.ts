import { z } from 'zod';

/** `ovo.human-queue-callback/1`: what a third party posts back (design 4.2.1). */
const Destination = z
  .object({
    e164: z.string().max(32).optional(),
    sipUri: z.string().max(512).optional(),
    headers: z.record(z.string().max(64), z.string().max(256)).optional(),
  })
  .strict();
/** `ovo.human-queue-callback/1`. */
export const CallbackBodySchema = z
  .object({
    eventId: z.string().min(1).max(200),
    event: z.enum(['destination', 'accepted', 'released', 'outcome']),
    ticketRef: z.string().max(200).optional(),
    occurredAt: z.iso.datetime().optional(),
    destination: Destination.optional(),
    outcome: z
      .enum(['answered', 'abandoned', 'no_answer', 'busy', 'completed', 'failed'])
      .optional(),
    reason: z.string().max(200).optional(),
  })
  .strict();
export type CallbackBody = z.infer<typeof CallbackBodySchema>;
