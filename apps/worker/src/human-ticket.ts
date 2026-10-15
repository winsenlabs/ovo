import type { HumanAttemptInit } from './human-attempt.ts';
import type { NewTicket, Ticket, TicketContext, TicketReleaseCode } from './human-contract.ts';
import { humanRequested, humanState, type QueueRef } from './human-events.ts';
import type { HumanRuntime } from './human-runtime.ts';

/** The ticket a store answered with, as opposed to its `conflict`. */
export function isTicket(answer: Ticket | { kind: 'conflict' }): answer is Ticket {
  return 'status' in answer;
}

/** The contract's four release reasons (`HumanHandoffRelease.reason`). */
function legacyReason(
  code: TicketReleaseCode,
): 'completed' | 'declined' | 'timed_out' | 'call_ended' {
  if (code === 'call_ended') return 'call_ended';
  if (code === 'timed_out' || code === 'operator_no_show' || code === 'worker_lost')
    return 'timed_out';
  if (code === 'declined') return 'declined';
  return 'completed';
}

/**
 * Creates the idempotent ticket of a committed handoff (human queue design 7.3): its key is
 * `hq:<workspace>:<job>:<n>`, its context is built under the queue's policy and stored in the
 * ticket row only. A full queue and a store that is down are codes for the hold's chain (storage
 * down fails closed: no ticket means nobody can answer).
 */
export async function openTicket(
  rt: HumanRuntime,
  init: HumanAttemptInit,
  ref: QueueRef,
): Promise<{ ticket: Ticket; context: TicketContext; idempotencyKey: string } | string> {
  const { deps } = rt;
  const { queue } = init;
  const context = await rt.context({
    queue,
    from: init.from,
    ...(init.catalogue ? { target: init.catalogue } : {}),
    ...(init.meta ? { meta: init.meta } : {}),
  });
  const def = queue.definition;
  const now = deps.clock.now();
  const idempotencyKey = `hq:${deps.call.workspaceId}:${deps.call.jobId}:${rt.nextTicket()}`;
  const expires = now + init.waitSeconds * 1000;
  const input: NewTicket = {
    callId: deps.call.jobId,
    sessionId: deps.call.sessionId,
    idempotencyKey,
    routingReleaseId: deps.call.routingReleaseId,
    queue: {
      id: queue.id,
      key: queue.key,
      name: def.name,
      kind: def.kind,
      mode: def.kind === 'managed' ? def.assignment : 'OPEN_PICKUP',
      teamIds: def.kind === 'managed' ? def.teamIds : [],
      language: def.kind === 'managed' ? def.language : 'ignore',
      maxWaiting: def.limits.maxWaiting,
    },
    priority: queue.priority,
    ...(deps.memory.route?.language ? { language: deps.memory.route.language } : {}),
    ...(rt.masked() ? { callerMasked: rt.masked()! } : {}),
    expiresAt: new Date(expires).toISOString(),
    routerAgentId: deps.call.routerAgentId,
    ...(def.kind === 'external'
      ? {
          credentialId: def.webhook.credentialId,
          callbackUntil: new Date(expires + def.callbackWindowHours * 3_600_000).toISOString(),
        }
      : { offerSeconds: def.offerSeconds }),
    context,
    contextRetentionHours: deps.contextRetentionHours,
  };
  let created;
  try {
    created = await deps.service.tickets.create(input);
  } catch {
    // swallow-ok: no ticket means nobody can answer: fail closed into the chain.
    deps.audit('human.ticket.failed', { queue: queue.key });
    return 'ticket_create_failed';
  }
  if (created === 'queue_full') return 'queue_full';
  const ticket = typeof created === 'object' && 'ticket' in created ? created.ticket : created;
  deps.record(
    'human.requested',
    humanRequested(ref, {
      source: init.source,
      result: 'accepted',
      ticket: ticket.id,
      priority: queue.priority,
      ...(init.transfer !== undefined ? { transfer: init.transfer } : {}),
    }),
  );
  deps.record(
    'human.state',
    humanState(ticket.id, 'waiting', { by: 'worker', version: ticket.version }),
  );
  const fields = { jobId: deps.call.jobId, queue: queue.key, kind: def.kind };
  deps.log('human_requested', { ...fields, source: init.source });
  deps.log('human_ticket', fields);
  return { ticket, context, idempotencyKey };
}

/** Releases the ticket with `code`; a conflict means someone else already did. */
export async function releaseTicket(
  rt: HumanRuntime,
  ticketId: string,
  code: TicketReleaseCode,
  by: 'worker' | 'operator' = 'worker',
): Promise<void> {
  const { service, call } = rt.deps;
  try {
    for (let tries = 0; tries < 2; tries += 1) {
      const current = await service.tickets.get(ticketId);
      if (!current || current.status === 'released' || current.status === 'expired') return;
      const released = await service.tickets.release({
        workspaceId: call.workspaceId,
        ticketId: current.id,
        expectedVersion: current.version,
        reason: legacyReason(code),
        idempotencyKey: `${current.id}:release:${code}`,
        code,
        by,
      });
      if (isTicket(released)) {
        rt.deps.record(
          'human.state',
          humanState(current.id, 'released', { by, code, version: released.version }),
        );
        return;
      }
    }
  } catch {
    // swallow-ok: the sweeper expires a ticket whose release could not be written.
    rt.deps.audit('human.release.failed', { code });
  }
}
