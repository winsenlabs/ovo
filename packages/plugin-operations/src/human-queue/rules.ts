import type { OperatorStatus } from '@winsendotai/ovo-contracts';
import type { OperatorRecord, TicketRow } from './rows.ts';

/** How long an operator's last heartbeat keeps them online. */
export const DEFAULT_PRESENCE_TTL_SECONDS = 30;
/** No worker beat for this long and an active ticket is `worker_lost`. */
export const WORKER_LOST_MS = 20_000;

export interface QueueRules {
  teamIds: readonly string[];
  languageMode: 'ignore' | 'prefer' | 'require';
}

/** Stored presence, read through the heartbeat: a stale operator is OFFLINE without a write. */
export function effectiveStatus(
  operator: Pick<OperatorRecord, 'status' | 'lastSeenAt'>,
  now: Date,
  ttlSeconds: number,
): OperatorStatus {
  if (operator.status === 'OFFLINE' || !operator.lastSeenAt) return 'OFFLINE';
  return now.getTime() - operator.lastSeenAt.getTime() <= ttlSeconds * 1_000
    ? operator.status
    : 'OFFLINE';
}

/** Team and language only; presence, capacity and declines are separate rules. */
export function mayServe(
  operator: Pick<OperatorRecord, 'enabled' | 'teamIds' | 'languages'>,
  queue: QueueRules,
  language: string | undefined,
): boolean {
  if (!operator.enabled) return false;
  if (queue.teamIds.length > 0 && !queue.teamIds.some((team) => operator.teamIds.includes(team)))
    return false;
  if (queue.languageMode === 'require')
    return language !== undefined && operator.languages.includes(language);
  return true;
}

export const rulesOf = (ticket: Pick<TicketRow, 'teamIds' | 'languageMode'>): QueueRules => ({
  teamIds: ticket.teamIds,
  languageMode: ticket.languageMode,
});

/** The order tickets are served in: priority first, then the longest waiting. */
export function byService(a: TicketRow, b: TicketRow): number {
  return b.priority - a.priority || a.createdAt.getTime() - b.createdAt.getTime();
}

export interface Candidate {
  operator: OperatorRecord;
  /** Tickets accepted plus tickets currently offered. */
  load: number;
}

/**
 * The AUTO_ASSIGN pick among operators already known to be online, eligible, not declined and with
 * room: language match first (`prefer`), then the lightest load, then the longest idle, then id.
 */
export function pickOperator(
  candidates: readonly Candidate[],
  ticket: Pick<TicketRow, 'languageMode' | 'language'>,
): OperatorRecord | undefined {
  const matches = (c: Candidate) =>
    ticket.languageMode === 'prefer' && ticket.language !== undefined
      ? c.operator.languages.includes(ticket.language)
        ? 0
        : 1
      : 0;
  return [...candidates].sort(
    (a, b) =>
      matches(a) - matches(b) ||
      a.load - b.load ||
      (a.operator.lastAssignedAt?.getTime() ?? 0) - (b.operator.lastAssignedAt?.getTime() ?? 0) ||
      a.operator.userId.localeCompare(b.operator.userId),
  )[0]?.operator;
}
