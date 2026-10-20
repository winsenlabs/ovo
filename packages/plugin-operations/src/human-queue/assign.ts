import { effectiveStatus, mayServe, pickOperator, rulesOf, type Candidate } from './rules.ts';
import type { HqTx } from './store.ts';
import type { TicketRow } from './rows.ts';
import { record, type EngineContext } from './transitions.ts';

/** Tickets each operator holds (accepted) and has been offered (offered), from one scan. */
export async function loads(tx: HqTx): Promise<Map<string, { accepted: number; offered: number }>> {
  const found = new Map<string, { accepted: number; offered: number }>();
  for (const row of await tx.scan({ kind: 'managed', statuses: ['accepted', 'offered'] })) {
    if (!row.assignedOperatorId) continue;
    const load = found.get(row.assignedOperatorId) ?? { accepted: 0, offered: 0 };
    if (row.status === 'accepted') load.accepted += 1;
    else load.offered += 1;
    found.set(row.assignedOperatorId, load);
  }
  return found;
}

/**
 * AUTO_ASSIGN: offers a waiting ticket to the best online operator with room that has not declined
 * it. Returns the offered ticket, or `undefined` when nobody qualifies (it stays waiting).
 */
export async function offerTicket(
  tx: HqTx,
  ctx: EngineContext,
  ticket: TicketRow,
  known?: Map<string, { accepted: number; offered: number }>,
): Promise<TicketRow | undefined> {
  if (ticket.status !== 'waiting' || ticket.kind !== 'managed' || ticket.mode !== 'AUTO_ASSIGN')
    return undefined;
  const now = ctx.now();
  const load = known ?? (await loads(tx));
  const candidates: Candidate[] = [];
  for (const operator of await tx.operators()) {
    if (effectiveStatus(operator, now, ctx.presenceTtlSeconds) !== 'AVAILABLE') continue;
    if (!mayServe(operator, rulesOf(ticket), ticket.language)) continue;
    if (ticket.declinedBy.includes(operator.userId)) continue;
    const held = load.get(operator.userId) ?? { accepted: 0, offered: 0 };
    if (held.accepted + held.offered >= operator.capacity) continue;
    candidates.push({ operator, load: held.accepted + held.offered });
  }
  const chosen = pickOperator(candidates, ticket);
  if (!chosen) return undefined;
  const offered = await tx.updateTicket(ticket.id, {
    status: 'offered',
    version: ticket.version + 1,
    assignedOperatorId: chosen.userId,
    offerExpiresAt: new Date(now.getTime() + ticket.offerSeconds * 1_000),
  });
  await tx.putOperator({ ...chosen, lastAssignedAt: now });
  const held = load.get(chosen.userId) ?? { accepted: 0, offered: 0 };
  held.offered += 1;
  load.set(chosen.userId, held);
  await record(tx, offered, now, { state: 'offered', by: 'sweeper', operator: chosen.userId });
  return offered;
}
