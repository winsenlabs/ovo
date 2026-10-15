import { z } from 'zod';
import { OPERATOR_STATUSES } from '@winsendotai/ovo-contracts';
import { registerDeskTicketRoutes } from './desk-tickets.ts';
import { deskQueues, deskStats } from './desk-me.ts';
import {
  desked,
  invalid,
  zodIssues,
  type HumanQueueRouteDependencies,
  type RoomHealth,
} from './human-queue-support.ts';
import { sendError, type RoutingAudit } from './routing-support.ts';

const TicketParams = z.object({ ticketId: z.uuid() });
const PresenceBody = z.object({ status: z.enum(OPERATOR_STATUSES) }).strict();
const ListQuery = z.object({ scope: z.enum(['queue', 'mine']).default('queue') });
const DeclineBody = z.object({ expectedVersion: z.number().int().positive() }).strict();

/**
 * The operator desk's REST surface (design 6.2) except accept and the stream. Every route needs
 * `viewer` and an enabled operator profile; every ticket route checks the ticket is the caller's
 * to see. Caller numbers stay masked in lists; the full context goes only to the assigned operator.
 */
export function registerDeskRoutes(
  input: HumanQueueRouteDependencies & { audit: RoutingAudit; health: RoomHealth },
): void {
  const { app } = input;

  app.get(
    '/v1/desk/me',
    desked(input, async ({ reply, profile, queues }) => {
      const mine = await deskQueues(input, queues, profile);
      const { status, stats } = await deskStats(
        queues,
        profile,
        mine.map((queue) => queue.id),
      );
      return reply.header('cache-control', 'no-store').send({
        profile,
        status,
        queues: mine,
        roomProvider: {
          provider: input.rooms?.provider ?? '',
          serverUrl: input.rooms?.publicUrl ?? '',
        },
        presenceTtlSeconds: input.presenceTtlSeconds,
        stats,
      });
    }),
  );

  app.put(
    '/v1/desk/presence',
    desked(input, async ({ request, reply, profile, queues }) => {
      const body = PresenceBody.safeParse(request.body ?? {});
      if (!body.success)
        return invalid(reply, 'presence_invalid', 'Presence is invalid', zodIssues(body.error));
      return queues.operators.heartbeat(profile.userId, body.data.status);
    }),
  );

  app.post(
    '/v1/desk/heartbeat',
    desked(input, async ({ profile, queues }) => queues.operators.heartbeat(profile.userId)),
  );

  app.get(
    '/v1/desk/tickets',
    desked(input, async ({ request, profile, queues }) => ({
      items: await queues.tickets.listForOperator(
        profile.userId,
        ListQuery.parse(request.query).scope,
      ),
    })),
  );

  app.post(
    '/v1/desk/tickets/:ticketId/decline',
    desked(input, async ({ request, reply, principal, profile, queues, audit }) => {
      const { ticketId } = TicketParams.parse(request.params);
      const body = DeclineBody.safeParse(request.body ?? {});
      if (!body.success)
        return invalid(reply, 'decline_invalid', 'Request is invalid', zodIssues(body.error));
      const declined = await queues.tickets.decline({
        ticketId,
        operatorId: profile.userId,
        expectedVersion: body.data.expectedVersion,
      });
      if (!('id' in declined))
        return sendError(reply, 409, 'conflict', 'This call changed; refresh the queue');
      await audit(principal, 'desk.decline', 'human_ticket', ticketId, {
        version: declined.version,
      });
      return reply.code(204).send();
    }),
  );

  registerDeskTicketRoutes(input);
}
