import type { TicketOutcome, TicketReleaseCode } from './human-contract.ts';

/** The worker confirms a held call to the store this often (the sweeper allows four times this). */
export const BEAT_MS = 5_000;
/** An operator who drops out has this long to come back before `onOperatorLeave` applies. */
export const OPERATOR_GRACE_MS = 5_000;

/** How a human segment ended, as the ticket and `human.completed` record it. */
export type End = { code: TicketReleaseCode; outcome: TicketOutcome; ending?: 'operator_end' };

/** The end a close with no command or leave behind it stands for. */
export function endOf(reason: string): End {
  if (reason === 'caller_hangup') return { code: 'call_ended', outcome: 'caller_hangup' };
  return { code: 'completed', outcome: 'ended' };
}
