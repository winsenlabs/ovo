import { loads, offerTicket } from './assign.ts';
import { byService } from './rules.ts';
import { WORKER_LOST_MS } from './rules.ts';
import { ACTIVE } from './rows.ts';
import type { SweepResult } from './service.ts';
import type { HqStore } from './store.ts';
import { finishTicket, record, SCRUBBED, type EngineContext } from './transitions.ts';

const NAME = 'ovo-human-queue-sweep';

/**
 * One sweeper pass, single flight (a second caller gets zeros): worker-lost tickets, deadlines,
 * lapsed offers, AUTO_ASSIGN offers, and context scrubbing. The rows it touches are locked, and
 * rows another unit is changing are left for the next pass.
 */
export async function sweepOnce(
  store: HqStore,
  ctx: EngineContext,
  at: Date,
): Promise<SweepResult> {
  const result: SweepResult = { assigned: 0, expired: 0, reoffered: 0, scrubbed: 0, stale: 0 };
  const swept = await store.singleFlight(NAME, async (tx) => {
    await tx.lockAssignment();
    const lostBefore = at.getTime() - WORKER_LOST_MS;
    for (const row of await tx.scan({ statuses: ACTIVE, lock: true })) {
      const beat = (row.workerHeartbeatAt ?? row.createdAt).getTime();
      if (beat < lostBefore) {
        await finishTicket(tx, row, at, {
          status: 'released',
          code: 'worker_lost',
          by: 'sweeper',
          outcome: 'failed',
        });
        result.stale += 1;
      } else if (row.status !== 'accepted' && row.expiresAt <= at) {
        await finishTicket(tx, row, at, {
          status: 'expired',
          code: 'timed_out',
          by: 'sweeper',
          outcome: 'timeout',
        });
        result.expired += 1;
      } else if (row.status === 'offered' && row.offerExpiresAt && row.offerExpiresAt <= at) {
        const lapsed = await tx.updateTicket(row.id, {
          status: 'waiting',
          version: row.version + 1,
          assignedOperatorId: null,
          offerExpiresAt: null,
          declinedBy: [
            ...new Set([
              ...row.declinedBy,
              ...(row.assignedOperatorId ? [row.assignedOperatorId] : []),
            ]),
          ],
        });
        await record(tx, lapsed, at, {
          state: 'waiting',
          by: 'sweeper',
          code: 'declined',
          ...(row.assignedOperatorId ? { operator: row.assignedOperatorId } : {}),
        });
        result.reoffered += 1;
      }
    }
    const waiting = (await tx.scan({ kind: 'managed', statuses: ['waiting'], lock: true })).filter(
      (row) => row.mode === 'AUTO_ASSIGN',
    );
    const load = await loads(tx);
    for (const row of waiting.sort(byService))
      if (await offerTicket(tx, ctx, row, load)) result.assigned += 1;
    for (const row of await tx.scan({ scrubDue: at, lock: true })) {
      await tx.updateTicket(row.id, SCRUBBED);
      result.scrubbed += 1;
    }
    return true;
  });
  return swept ? result : { assigned: 0, expired: 0, reoffered: 0, scrubbed: 0, stale: 0 };
}
