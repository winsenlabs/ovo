import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  checkDestination,
  type HumanQueueDefinition,
  type WebhookDestination,
} from '@winsendotai/ovo-contracts';
import { externalContext, policyOf } from '../human-queue-context-policy.ts';
import { RateLimiter } from '../human-queue-ports.ts';
import {
  disabled,
  humanQueuesOf,
  type HumanQueueRouteDependencies,
} from './human-queue-support.ts';
import { sendError } from './routing-support.ts';

const CALLBACK_BYTES = 16 * 1024;
const CONTEXT_TOKEN_QUERY = z.object({ t: z.string().min(16).max(200) });
const TicketParams = z.object({ ticketId: z.uuid() });

const Destination = z
  .object({
    e164: z.string().max(32).optional(),
    sipUri: z.string().max(512).optional(),
    headers: z.record(z.string().max(64), z.string().max(256)).optional(),
  })
  .strict();
/** `ovo.human-queue-callback/1`. */
const CallbackBody = z
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
type Callback = z.infer<typeof CallbackBody>;

const header = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : undefined;

/**
 * The two endpoints a third-party queue calls (design 6.3), public by the session rules and
 * authenticated by what they carry. `POST /v1/human-queue/callbacks/:id` takes a signed event
 * (HMAC over `timestamp.eventId.body` with the credential resolved for the router agent on the
 * ticket); `GET /v1/human-queue/context/:id?t=` serves the policy-filtered context to a ticket-
 * scoped bearer. Neither says more about a ticket than its status code.
 */
export function registerHumanQueueCallbackRoutes(
  input: HumanQueueRouteDependencies & {
    callbackLimiter?: RateLimiter;
  },
): void {
  const now = input.now ?? Date.now;
  const limiter = input.callbackLimiter ?? new RateLimiter(60, 60_000, now);
  const sourceLimiter = new RateLimiter(60, 60_000, now);
  const service = () => (input.flags.enabled ? humanQueuesOf(input.operations) : undefined);
  const limited = (ticketId: string, ip: string) =>
    !limiter.take(`ticket:${ticketId}`) || !sourceLimiter.take(`ip:${ip}`);

  // The signature covers the exact bytes, so this scope keeps the JSON body as text.
  input.app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) =>
      done(null, body),
    );

    scope.post(
      '/v1/human-queue/callbacks/:ticketId',
      { bodyLimit: CALLBACK_BYTES },
      async (request, reply) => {
        const queues = service();
        if (!queues) return disabled(reply);
        const params = TicketParams.safeParse(request.params);
        if (!params.success) return sendError(reply, 404, 'ticket_not_found', 'Ticket not found');
        const { ticketId } = params.data;
        if (limited(ticketId, request.ip))
          return reply
            .header('retry-after', '60')
            .code(429)
            .send({ error: { code: 'rate_limited', message: 'Too many callbacks' } });
        const ticket = await queues.tickets.get(ticketId);
        if (!ticket || ticket.kind !== 'external')
          return sendError(reply, 404, 'ticket_not_found', 'Ticket not found');
        const text = typeof request.body === 'string' ? request.body : '';
        if (ticket.callbackUntil !== undefined && Date.parse(ticket.callbackUntil) < now())
          return sendError(
            reply,
            410,
            'callback_window_closed',
            'This ticket no longer accepts callbacks',
          );

        const secret = await callbackSecret(input, ticket);
        const verdict = secret
          ? input.egress.verify({
              secret,
              timestamp: header(request.headers['x-ovo-timestamp']),
              id: header(request.headers['x-ovo-event-id']),
              body: text,
              signature: header(request.headers['x-ovo-signature']),
              now: now(),
            })
          : 'mismatch';
        if (verdict !== 'ok')
          return sendError(
            reply,
            401,
            'invalid_signature',
            'The callback signature was not accepted',
          );

        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          return sendError(reply, 422, 'invalid_callback', 'The callback body is not JSON');
        }
        const body = CallbackBody.safeParse(json);
        if (!body.success || body.data.eventId !== header(request.headers['x-ovo-event-id']))
          return sendError(reply, 422, 'invalid_callback', 'The callback body is invalid', {
            issues: body.success
              ? [{ path: ['eventId'], message: 'Must equal x-ovo-event-id' }]
              : body.error.issues,
          });
        return applyCallback(input, queues, ticket, body.data, reply, request.log);
      },
    );
  });

  input.app.get('/v1/human-queue/context/:ticketId', async (request, reply) => {
    const queues = service();
    if (!queues) return disabled(reply);
    const params = TicketParams.safeParse(request.params);
    const query = CONTEXT_TOKEN_QUERY.safeParse(request.query);
    if (!params.success) return sendError(reply, 404, 'ticket_not_found', 'Ticket not found');
    const { ticketId } = params.data;
    if (limited(ticketId, request.ip))
      return reply
        .header('retry-after', '60')
        .code(429)
        .send({ error: { code: 'rate_limited', message: 'Too many requests' } });
    if (!query.success)
      return sendError(reply, 401, 'invalid_token', 'A valid link token is required');
    const context = await queues.tickets.context(ticketId, { token: query.data.t });
    if (context === undefined) return sendError(reply, 404, 'ticket_not_found', 'Ticket not found');
    if (context === 'forbidden')
      return sendError(reply, 401, 'invalid_token', 'A valid link token is required');
    if (context === 'expired')
      return sendError(reply, 410, 'context_expired', 'This link has expired');
    const ticket = await queues.tickets.get(ticketId);
    const queue = ticket && (await queues.queues.get(ticket.queueId, { includeDeleted: true }));
    return reply
      .header('cache-control', 'no-store')
      .send(externalContext(context, policyOf(queue ? queue.definition : undefined)));
  });
}

/** The signing secret for a ticket, resolved now for the router agent it was made for. */
async function callbackSecret(
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

type TicketRow = NonNullable<
  Awaited<ReturnType<NonNullable<ReturnType<typeof humanQueuesOf>>['tickets']['get']>>
>;

/** Records the event once (the event id is the replay guard), then does what it asks. */
async function applyCallback(
  input: HumanQueueRouteDependencies,
  queues: NonNullable<ReturnType<typeof humanQueuesOf>>,
  ticket: TicketRow,
  callback: Callback,
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
  callback: Callback,
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
