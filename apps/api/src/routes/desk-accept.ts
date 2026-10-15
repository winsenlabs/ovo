import { z } from 'zod';
import { humanRoomName, type DeskAcceptResult } from '@winsendotai/ovo-contracts';
import { ROOM_EMPTY_SECONDS, ROOM_MAX_PARTICIPANTS, mintOperatorGrant } from './desk-grant.ts';
import {
  desked,
  type HumanQueueRouteDependencies,
  type RoomHealth,
} from './human-queue-support.ts';
import { sendError, type RoutingAudit } from './routing-support.ts';

const TicketParams = z.object({ ticketId: z.uuid() });
const AcceptBody = z
  .object({
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();

const roomUnavailable = (reply: Parameters<typeof sendError>[0]) =>
  sendError(reply, 503, 'room_unavailable', 'Calls cannot be answered in the browser right now');

/**
 * `POST /v1/desk/tickets/:id/accept` (design 6.2). The room is made and the token minted *before*
 * the compare-and-set, so a room server that is down answers 503 with the ticket untouched and
 * still offered to everyone. The ticket service then decides: exactly one of concurrent operators
 * wins; the rest get 409 with the ticket as it is now. A repeat with the same key by the same
 * operator returns the same ticket and a fresh token.
 */
export function registerDeskAcceptRoute(
  input: HumanQueueRouteDependencies & { audit: RoutingAudit; health: RoomHealth },
): void {
  input.app.post(
    '/v1/desk/tickets/:ticketId/accept',
    desked(input, async ({ request, reply, principal, profile, queues, audit }) => {
      const { ticketId } = TicketParams.parse(request.params);
      const body = AcceptBody.safeParse(request.body ?? {});
      if (!body.success)
        return sendError(reply, 400, 'validation_error', 'Request validation failed', {
          issues: body.error.issues,
        });
      const ticket = await queues.tickets.get(ticketId);
      if (!ticket || ticket.kind !== 'managed')
        return sendError(reply, 404, 'ticket_not_found', 'Ticket not found');
      const { rooms } = input;
      if (!rooms) return roomUnavailable(reply);
      // One room per accept, named by the version the accept produces: a token left over from an
      // operator who was replaced opens a room nobody bridges.
      const roomName = humanRoomName(ticketId, body.data.expectedVersion + 1);
      let grant;
      try {
        await rooms.ensureRoom({
          name: roomName,
          maxParticipants: ROOM_MAX_PARTICIPANTS,
          emptyTimeoutSeconds: ROOM_EMPTY_SECONDS,
        });
        grant = await mintOperatorGrant(rooms, {
          ticketId,
          roomName,
          userId: profile.userId,
          displayName: profile.displayName,
          ttlSeconds: input.roomTokenTtlSeconds,
        });
      } catch (error) {
        input.health.invalidate();
        request.log.warn({ err: error }, 'human queue room unavailable at accept');
        return roomUnavailable(reply);
      }
      const accepted = await queues.tickets.accept({
        workspaceId: principal.workspaceId,
        ticketId,
        operatorId: profile.userId,
        expectedVersion: body.data.expectedVersion,
        idempotencyKey: body.data.idempotencyKey,
        roomName,
      });
      // A refusal is `{ kind }`; a ticket has an `id` (and a `kind` of its own, so not that).
      if (!('id' in accepted)) {
        if (accepted.kind === 'not_eligible')
          return sendError(reply, 403, 'not_eligible', 'This call is not for your queues');
        if (accepted.kind === 'at_capacity')
          return sendError(reply, 409, 'at_capacity', 'You are at your call limit');
        const current = (await queues.tickets.listForOperator(profile.userId, 'queue')).find(
          (view) => view.id === ticketId,
        );
        return sendError(reply, 409, 'conflict', 'Another operator took this call', {
          current: current ?? null,
        });
      }
      const [mine, context] = await Promise.all([
        queues.tickets.listForOperator(profile.userId, 'mine'),
        queues.tickets.context(ticketId, { operatorId: profile.userId }),
      ]);
      const view = mine.find((candidate) => candidate.id === ticketId);
      if (!view || typeof context !== 'object')
        return sendError(
          reply,
          410,
          'context_unavailable',
          'The call details are no longer available',
        );
      await audit(principal, 'desk.accept', 'human_ticket', ticketId, {
        queueId: ticket.queueId,
        version: accepted.version,
      });
      const result: DeskAcceptResult = { ticket: view, room: grant, context };
      return reply.header('cache-control', 'no-store').send(result);
    }),
  );
}
