import { z } from 'zod';

/** Durable event envelopes evolve through explicit schema versions. */
export const DurableEvent = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    ownershipEpoch: z.number().int().nonnegative(),
    timestamp: z.iso.datetime(),
    ingestedAt: z.iso.datetime(),
    type: z.enum([
      'caller.accepted',
      'speech.generated',
      'speech.sent',
      'speech.completed',
      'speech.interrupted',
      'operation.intent',
      'operation.settled',
      'session.started',
      'session.ended',
      'session.failed',
    ]),
    responseEpoch: z.number().int().nonnegative().optional(),
    operationId: z.string().optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type DurableEvent = z.infer<typeof DurableEvent>;

/** Reject unknown generations rather than silently interpreting them as current data. */
export function readDurableEvent(input: unknown): DurableEvent {
  return DurableEvent.parse(input);
}
