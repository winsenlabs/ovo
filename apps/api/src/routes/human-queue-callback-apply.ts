import { randomUUID } from 'node:crypto';
import {
  checkDestination,
  type HumanQueueDefinition,
  type WebhookDestination,
} from '@winsendotai/ovo-contracts';
import type { CallbackBody } from './human-queue-callback-body.ts';
import type { ApiHumanQueueService, HumanQueueRouteDependencies } from './human-queue-support.ts';
import { sendError } from './routing-support.ts';

/** The signing secret for a ticket, resolved now for the router agent it was made for. */
export async function callbackSecret(
  input: Pick<HumanQueueRouteDependencies, 'secrets' | 'operations'>,
  ticket: { routerAgentId?: string; credentialId?: string },
): Promise<string | undefined> {
  if (!input.secrets || !ticket.routerAgentId || !ticket.credentialId) return undefined;
  try {
    return await input.secrets
      .forAgent(ticket.routerAgentId)
      .resolve(input.operations!.organizationId, ticket.credentialId);
  } catch {
    return undefined;
  }
}

type TicketRow = NonNullable<Awaited<ReturnType<ApiHumanQueueService['tickets']['get']>>>;

/** Records the event once (the event id is the replay guard), then does what it asks. */
export async function applyCallback(
  input: HumanQueueRouteDependencies,
  queues: ApiHumanQueueService,
  ticket: TicketRow,
  callback: CallbackBody,
  reply: Parameters<typeof sendError>[0],
  log: { warn(object: unknown, message: string): void },
) {
  const queue = await queues.queues.get(ticket.queueId, { includeDeleted: true });
  const definition: HumanQueueDefinition | undefined = queue?.definition;
  let destination: WebhookDestination | undefined;
  if (callback.event === 'destination') {
    if (definition?.kind !== 'external' || !callback.destination)
      return sendError(
        reply,
        422,
        'invalid_callback',
        'A destination callback needs a destination',
      );
    const checked = checkDestination(definition.destination, callback.destination);
    if (!checked.ok) {
      await queues.tickets.appendEvent(ticket.id, {
        kind: 'callback.destination_refused',
        sourceEventId: callback.eventId,
        payload: { code: checked.reason },
      });
      return sendError(
        reply,
        422,
        'destination_refused',
        'The destination is outside the queue’s allow-list',
        {
          reason: checked.reason,
        },
      );
    }
    destination =
      checked.target.kind === 'phone'
        ? { e164: checked.target.e164 }
        : { sipUri: checked.target.uri, headers: checked.target.headers };
  }
  const recorded = await queues.tickets.appendEvent(ticket.id, {
    kind: `callback.${callback.event}`,
    sourceEventId: callback.eventId,
    payload: {
      event: callback.event,
      ...(callback.outcome ? { outcome: callback.outcome } : {}),
      ...(callback.reason ? { reason: callback.reason.slice(0, 80) } : {}),
    },
  });
  if (recorded === 'duplicate') return reply.code(202).send({ result: 'duplicate' });

  if (destination) {
    if (
      !(await queues.tickets.setDestination(ticket.id, 'callback', destination, callback.ticketRef))
    )
      return sendError(
        reply,
        409,
        'destination_not_accepted',
        'This ticket cannot take a destination now',
      );
  } else if (
    callback.event === 'released' &&
    (ticket.status === 'waiting' || ticket.status === 'offered')
  ) {
    // The third party gave up on a caller still holding: the worker sees the release and moves on.
    await queues.tickets.release({
      workspaceId: input.operations!.organizationId,
      ticketId: ticket.id,
      expectedVersion: ticket.version,
      reason: 'declined',
      idempotencyKey: `callback:${callback.eventId}`,
      code: 'webhook_rejected',
      by: 'callback',
      outcome: 'rejected',
    });
  }
  await appendToCall(input, ticket, callback, log);
  return reply.code(202).send({ result: 'applied' });
}

/** The callback on the finished call's log, so the inspector shows it after the call ended. */
async function appendToCall(
  input: HumanQueueRouteDependencies,
  ticket: TicketRow,
  callback: CallbackBody,
  log: { warn(object: unknown, message: string): void },
): Promise<void> {
  if (!input.outcomes?.available) return;
  try {
    const store = await input.outcomes.open();
    await store.append(input.operations!.organizationId, ticket.callId, [
      {
        id: `hq-callback:${ticket.id}:${callback.eventId}`.slice(0, 200) || randomUUID(),
        at: new Date((input.now ?? Date.now)()).toISOString(),
        type: 'human.state',
        payload: {
          ticket: ticket.id,
          state:
            callback.event === 'destination'
              ? 'destination'
              : callback.event === 'accepted'
                ? 'accepted'
                : 'released',
          by: 'callback',
          callback: callback.event,
          ...(callback.outcome ? { code: callback.outcome } : {}),
        },
      },
    ]);
  } catch (error) {
    log.warn({ err: error }, 'human queue callback could not be added to the call');
  }
}
