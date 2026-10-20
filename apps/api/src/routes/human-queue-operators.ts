import { z } from 'zod';
import { OperatorProfile } from '@winsendotai/ovo-contracts';
import {
  invalid,
  queued,
  zodIssues,
  type HumanQueueRouteDependencies,
} from './human-queue-support.ts';
import { sendError, type RoutingAudit } from './routing-support.ts';

const OperatorParams = z.object({ userId: z.string().min(1).max(200) });
const TicketParams = z.object({ ticketId: z.uuid() });

/**
 * Operator profiles and the admin's force-release (design 6.1). A profile is how an existing team
 * member becomes someone who may answer calls; presence is the desk's, not written here.
 */
export function registerHumanQueueOperatorRoutes(
  input: HumanQueueRouteDependencies & { audit: RoutingAudit },
): void {
  input.app.get(
    '/v1/human-queues/operators',
    queued(input, 'admin', async ({ queues }) => {
      const [profiles, team] = await Promise.all([
        queues.operators.list(),
        input.users ? input.users.list() : Promise.resolve(undefined),
      ]);
      const byId = new Map(team?.map((user) => [user.id, user]));
      return {
        items: profiles.map((row) => {
          const user = byId.get(row.userId);
          return {
            ...row,
            ...(user ? { label: user.label, email: user.email, userDisabled: user.disabled } : {}),
          };
        }),
      };
    }),
  );

  input.app.put(
    '/v1/human-queues/operators/:userId',
    queued(input, 'admin', async ({ request, reply, principal, queues, audit }) => {
      const { userId } = OperatorParams.parse(request.params);
      const body = OperatorProfile.safeParse({ ...(request.body as object), userId });
      if (!body.success)
        return invalid(
          reply,
          'operator_invalid',
          'Operator profile is invalid',
          zodIssues(body.error),
        );
      if (input.users) {
        const user = (await input.users.list()).find((candidate) => candidate.id === userId);
        if (!user) return sendError(reply, 404, 'user_not_found', 'No team member has this id');
        if (user.disabled && body.data.enabled)
          return invalid(reply, 'operator_invalid', 'A disabled user cannot answer calls', [
            { path: ['enabled'], message: 'This team member is disabled' },
          ]);
      }
      await queues.operators.upsert(body.data);
      await audit(principal, 'human_queue.operator.upsert', 'human_queue_operator', userId, {
        enabled: body.data.enabled,
        teams: body.data.teamIds.length,
        capacity: body.data.capacity,
      });
      return reply.code(200).send(body.data);
    }),
  );

  input.app.post(
    '/v1/human-queues/tickets/:ticketId/release',
    queued(input, 'admin', async ({ request, reply, principal, queues, audit }) => {
      const { ticketId } = TicketParams.parse(request.params);
      const ticket = await queues.tickets.get(ticketId);
      if (!ticket) return sendError(reply, 404, 'ticket_not_found', 'Ticket not found');
      const released = await queues.tickets.release({
        workspaceId: principal.workspaceId,
        ticketId,
        expectedVersion: ticket.version,
        reason: 'completed',
        idempotencyKey: `admin:${ticketId}`,
        code: 'operator_left',
        by: 'admin',
      });
      if (!('id' in released))
        return sendError(reply, 409, 'ticket_conflict', 'The ticket changed; try again');
      await audit(principal, 'human_queue.ticket.force_release', 'human_ticket', ticketId, {
        was: ticket.status,
      });
      return { id: released.id, status: released.status, releaseCode: released.releaseCode };
    }),
  );
}
