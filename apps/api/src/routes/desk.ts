import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DeskCommand, OPERATOR_STATUSES, WrapUp } from '@winsendotai/ovo-contracts';
import { deskQueues, deskStats } from './desk-me.ts';
import { mintOperatorGrant, operatorIdentity } from './desk-grant.ts';
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

  /** The assigned operator's active ticket, or the reply already sent. */
  const owned = async (
    call: Parameters<Parameters<typeof desked>[1]>[0],
    ticketId: string,
    options: { active: boolean },
  ) => {
    const ticket = await call.queues.tickets.get(ticketId);
    if (!ticket) return void sendError(call.reply, 404, 'ticket_not_found', 'Ticket not found');
    if (ticket.assignedOperatorId !== call.profile.userId)
      return void sendError(call.reply, 403, 'forbidden', 'This call is not yours');
    if (options.active && ticket.status !== 'accepted')
      return void sendError(call.reply, 409, 'ticket_not_active', 'This call has ended');
    return ticket;
  };

  app.post(
    '/v1/desk/tickets/:ticketId/token',
    desked(input, async (call) => {
      const { ticketId } = TicketParams.parse(call.request.params);
      const ticket = await owned(call, ticketId, { active: true });
      if (!ticket) return;
      if (!input.rooms)
        return sendError(
          call.reply,
          503,
          'room_unavailable',
          'Calls cannot be answered in the browser right now',
        );
      const room = await mintOperatorGrant(input.rooms, {
        ticketId,
        roomName: ticket.roomName,
        userId: call.profile.userId,
        displayName: call.profile.displayName,
        ttlSeconds: input.roomTokenTtlSeconds,
      });
      return call.reply.header('cache-control', 'no-store').send({ room });
    }),
  );

  app.get(
    '/v1/desk/tickets/:ticketId/context',
    desked(input, async ({ request, reply, profile, queues }) => {
      const { ticketId } = TicketParams.parse(request.params);
      const context = await queues.tickets.context(ticketId, { operatorId: profile.userId });
      if (context === undefined)
        return sendError(reply, 404, 'ticket_not_found', 'Ticket not found');
      if (context === 'forbidden')
        return sendError(reply, 403, 'forbidden', 'This call is not yours');
      if (context === 'expired')
        return sendError(reply, 410, 'context_expired', 'The call details were removed');
      return reply.header('cache-control', 'no-store').send(context);
    }),
  );

  app.post(
    '/v1/desk/tickets/:ticketId/commands',
    desked(input, async (call) => {
      const { ticketId } = TicketParams.parse(call.request.params);
      const parsed = DeskCommand.safeParse(call.request.body ?? {});
      if (!parsed.success)
        return invalid(
          call.reply,
          'command_invalid',
          'Command is invalid',
          zodIssues(parsed.error),
        );
      const ticket = await owned(call, ticketId, { active: true });
      if (!ticket) return;
      if (parsed.data.kind === 'return_to_agent') {
        const queue = await call.queues.queues.get(ticket.queueId, { includeDeleted: true });
        const allowed =
          queue?.definition.kind === 'managed' &&
          queue.definition.returnTargets.includes(parsed.data.target);
        if (!allowed)
          return invalid(
            call.reply,
            'return_target_not_allowed',
            'This queue cannot send callers there',
            [{ path: ['target'], message: 'The target must be one of the queue’s return targets' }],
          );
      }
      const seq = await call.queues.tickets.setCommand(ticketId, call.profile.userId, parsed.data);
      if (seq === 'forbidden')
        return sendError(call.reply, 403, 'forbidden', 'This call is not yours');
      if (seq === 'conflict')
        return sendError(call.reply, 409, 'ticket_not_active', 'This call has ended');
      await call.audit(call.principal, 'desk.command', 'human_ticket', ticketId, {
        kind: parsed.data.kind,
        seq,
      });
      return call.reply.code(202).send({ seq });
    }),
  );

  app.put(
    '/v1/desk/tickets/:ticketId/wrap-up',
    desked(input, async (call) => {
      const { ticketId } = TicketParams.parse(call.request.params);
      const parsed = WrapUp.safeParse(call.request.body ?? {});
      if (!parsed.success)
        return invalid(
          call.reply,
          'wrap_up_invalid',
          'Wrap-up is invalid',
          zodIssues(parsed.error),
        );
      const ticket = await owned(call, ticketId, { active: false });
      if (!ticket) return;
      const queue = await call.queues.queues.get(ticket.queueId, { includeDeleted: true });
      const choices =
        queue?.definition.kind === 'managed' ? queue.definition.wrapUp.dispositions : [];
      if (parsed.data.disposition && choices.length && !choices.includes(parsed.data.disposition))
        return invalid(call.reply, 'wrap_up_invalid', 'Wrap-up is invalid', [
          { path: ['disposition'], message: 'Choose one of the queue’s dispositions' },
        ]);
      if (!(await call.queues.tickets.setWrapUp(ticketId, call.profile.userId, parsed.data)))
        return sendError(
          call.reply,
          410,
          'wrap_up_closed',
          'The call details were removed, so it cannot be wrapped up',
        );
      if (parsed.data.disposition)
        await recordDisposition(
          input,
          call.principal.workspaceId,
          ticket.callId,
          ticketId,
          parsed.data.disposition,
          call.request.log,
        );
      await call.audit(call.principal, 'desk.wrap_up', 'human_ticket', ticketId, {
        disposition: parsed.data.disposition ?? null,
        note: parsed.data.note !== undefined,
      });
      return call.reply.code(204).send();
    }),
  );

  app.post(
    '/v1/desk/tickets/:ticketId/release',
    desked(input, async (call) => {
      const { ticketId } = TicketParams.parse(call.request.params);
      const ticket = await owned(call, ticketId, { active: true });
      if (!ticket) return;
      // The operator leaves the room; the worker sees the seat go and applies `onOperatorLeave`.
      if (input.rooms && ticket.roomName)
        await input.rooms
          .removeParticipant(ticket.roomName, operatorIdentity(call.profile.userId))
          .catch((error: unknown) =>
            call.request.log.warn({ err: error }, 'operator removal failed'),
          );
      await call.audit(call.principal, 'desk.leave', 'human_ticket', ticketId, {});
      return call.reply.code(202).send({ ok: true });
    }),
  );
}

/** The operator's disposition as a `disposition` call event (source `system`), once per choice. */
async function recordDisposition(
  input: Pick<HumanQueueRouteDependencies, 'outcomes' | 'now'>,
  workspaceId: string,
  callId: string,
  ticketId: string,
  disposition: string,
  log: { warn(object: unknown, message: string): void },
): Promise<void> {
  if (!input.outcomes?.available) return;
  try {
    const store = await input.outcomes.open();
    await store.append(workspaceId, callId, [
      {
        id: `hq-wrap:${ticketId}:${createHash('sha256').update(disposition).digest('hex').slice(0, 16)}`,
        at: new Date((input.now ?? Date.now)()).toISOString(),
        type: 'disposition',
        payload: { disposition, source: 'system', reason: 'operator wrap-up' },
      },
    ]);
  } catch (error) {
    log.warn({ err: error }, 'wrap-up disposition could not be recorded');
  }
}
