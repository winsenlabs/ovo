import { z } from 'zod';
import { RateLimiter } from '../human-queue-ports.ts';
import { applyCallback, callbackSecret } from './human-queue-callback-apply.ts';
import { CallbackBodySchema } from './human-queue-callback-body.ts';
import { registerHumanQueueContextRoute } from './human-queue-context.ts';
import {
  disabled,
  humanQueuesOf,
  type HumanQueueRouteDependencies,
} from './human-queue-support.ts';
import { sendError } from './routing-support.ts';

const CALLBACK_BYTES = 16 * 1024;
const TicketParams = z.object({ ticketId: z.uuid() });

const header = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : undefined;

/**
 * The endpoints a third-party queue calls (design 6.3), public by the session rules and
 * authenticated by what they carry. `POST /v1/human-queue/callbacks/:id` takes a signed event
 * (HMAC over `timestamp.eventId.body` with the credential resolved for the router agent on the
 * ticket), and the context link beside it (`human-queue-context.ts`) serves the policy-filtered
 * context to a ticket-scoped bearer. Neither says more about a ticket than its status code.
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
        const body = CallbackBodySchema.safeParse(json);
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

  registerHumanQueueContextRoute(input, limited);
}
