import { z } from 'zod';
import { externalContext, policyOf } from '../human-queue-context-policy.ts';
import { RateLimiter } from '../human-queue-ports.ts';
import {
  disabled,
  humanQueuesOf,
  type HumanQueueRouteDependencies,
} from './human-queue-support.ts';
import { sendError } from './routing-support.ts';

const CONTEXT_TOKEN_QUERY = z.object({ t: z.string().min(16).max(200) });
const TicketParams = z.object({ ticketId: z.uuid() });

/**
 * `GET /v1/human-queue/context/:id?t=` (design 6.3): the policy-filtered ticket context for a
 * third party's ticket-scoped bearer, valid 15 minutes, never cached. 401 for a missing or wrong
 * token, 410 once it expired, 404 for a ticket that is not there; 60 requests a minute per ticket
 * and per source address.
 */
export function registerHumanQueueContextRoute(
  input: HumanQueueRouteDependencies,
  limited: (ticketId: string, ip: string) => boolean,
): void {
  const service = () => (input.flags.enabled ? humanQueuesOf(input.operations) : undefined);
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
