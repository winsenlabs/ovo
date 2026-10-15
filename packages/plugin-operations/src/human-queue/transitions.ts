import type { TicketOutcome, TicketReleaseCode } from '@winsendotai/ovo-contracts';
import { DEFAULT_PRESENCE_TTL_SECONDS } from './rules.ts';
import type { TicketRow } from './rows.ts';
import type { HqTx, TicketPatch } from './store.ts';

export interface EngineContext {
  organizationId: string;
  now(): Date;
  presenceTtlSeconds: number;
}

export const defaultContext = (organizationId: string, now: () => Date): EngineContext => ({
  organizationId,
  now,
  presenceTtlSeconds: DEFAULT_PRESENCE_TTL_SECONDS,
});

/** Appends the audit event of a state change: ids and codes only, never caller text. */
export function record(
  tx: HqTx,
  ticket: TicketRow,
  at: Date,
  change: {
    state: string;
    by: string;
    operator?: string;
    code?: string;
    source?: string;
  },
): Promise<'recorded' | 'duplicate'> {
  const { source, ...rest } = change;
  return tx.addEvent(
    ticket.id,
    {
      kind: 'state',
      ...(source ? { sourceEventId: source } : {}),
      payload: { ...rest, version: ticket.version },
    },
    at,
  );
}

/** What a ticket's context looks like once its retention has run out. */
export const SCRUBBED: TicketPatch = {
  context: null,
  contextTokenHash: null,
  contextTokenExpiresAt: null,
  callerMasked: null,
  command: null,
};

/**
 * Ends a ticket: `released` (someone ended it) or `expired` (its deadline passed). The context is
 * kept `contextRetentionHours` more, or scrubbed now when that is 0.
 */
export async function finishTicket(
  tx: HqTx,
  row: TicketRow,
  at: Date,
  end: {
    status: 'released' | 'expired';
    code: TicketReleaseCode;
    by: string;
    outcome?: TicketOutcome;
    connect?: boolean;
  },
): Promise<TicketRow> {
  const keep = row.contextRetentionHours > 0;
  const finished = await tx.updateTicket(row.id, {
    status: end.status,
    version: row.version + 1,
    releaseCode: end.code,
    releasedAt: at,
    offerExpiresAt: null,
    ...(end.outcome ? { outcome: end.outcome } : {}),
    ...(end.connect && !row.connectedAt ? { connectedAt: at } : {}),
    contextExpiresAt: new Date(at.getTime() + row.contextRetentionHours * 3_600_000),
    ...(keep ? {} : SCRUBBED),
  });
  await record(tx, finished, at, {
    state: end.status,
    by: end.by,
    code: end.code,
    ...(row.assignedOperatorId ? { operator: row.assignedOperatorId } : {}),
  });
  return finished;
}
