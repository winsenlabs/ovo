import { type HqApp, WORKSPACE } from './human-queue-fixtures.ts';
import { makeQueue, managed, onlineOperator, openTicket } from './human-queue-data.ts';

/** Two queues (support, billing), operators for each, and one ticket waiting in support. */
export async function floor(hq: HqApp) {
  const support = await makeQueue(
    hq,
    managed({
      name: 'Support',
      teamIds: ['support'],
      returnTargets: ['bot'],
      wrapUp: { required: false, dispositions: ['Resolved', 'Escalated'] },
    }),
  );
  const billing = await makeQueue(hq, managed({ name: 'Billing', teamIds: ['billing'] }));
  await onlineOperator(hq, 'asha', { teamIds: ['support'] });
  await onlineOperator(hq, 'ravi', { teamIds: ['billing'] });
  const ticket = await openTicket(hq, support);
  return { support, billing, ticket };
}

export const accept = (hq: HqApp, ticket: { id: string; version: number }, operatorId: string) =>
  hq.service.tickets.accept({
    workspaceId: WORKSPACE,
    ticketId: ticket.id,
    operatorId,
    expectedVersion: ticket.version,
    idempotencyKey: `k-${ticket.id}-${operatorId}`,
  });
