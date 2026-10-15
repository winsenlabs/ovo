import { type HumanTicketView } from '@winsendotai/ovo-contracts';
import { mayServe, byService, rulesOf } from './rules.ts';
import { presentView } from './rows.ts';
import { type HqStore } from './store.ts';
import { type EngineContext } from './transitions.ts';

const MAX_VIEWS = 200;

/** What an operator sees: the queue, their own calls and the change feed behind the desk stream. */
export class TicketViews {
  constructor(
    private readonly store: HqStore,
    private readonly ctx: EngineContext,
  ) {}

  async listForOperator(userId: string, scope: 'queue' | 'mine'): Promise<HumanTicketView[]> {
    return this.store.run(async (tx) => {
      const now = this.ctx.now();
      const operator = await tx.operator(userId);
      if (!operator?.enabled) return [];
      if (scope === 'mine')
        return (await tx.scan({ assignedTo: userId, statuses: ['accepted'] })).map((row) =>
          presentView(row, userId, now),
        );
      const rows = await tx.scan({ kind: 'managed', statuses: ['waiting', 'offered'] });
      return rows
        .filter(
          (row) =>
            mayServe(operator, rulesOf(row), row.language) &&
            !row.declinedBy.includes(userId) &&
            (row.mode === 'OPEN_PICKUP'
              ? row.status === 'waiting'
              : row.status === 'offered' && row.assignedOperatorId === userId),
        )
        .sort(byService)
        .slice(0, MAX_VIEWS)
        .map((row) => presentView(row, userId, now));
    });
  }

  async changes(sinceChangeId: number, userId: string) {
    return this.store.run(async (tx) => {
      const now = this.ctx.now();
      const operator = await tx.operator(userId);
      const rows = await tx.scan({ kind: 'managed', sinceChangeId, limit: MAX_VIEWS });
      const cursor = rows.reduce((max, row) => Math.max(max, row.changeId), sinceChangeId);
      const items = rows
        .filter(
          (row) =>
            row.assignedOperatorId === userId ||
            (operator !== undefined && mayServe(operator, rulesOf(row), row.language)),
        )
        .map((row) => presentView(row, userId, now));
      return { items, cursor };
    });
  }
}
