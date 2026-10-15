import type { DeskMe, DeskStreamEvent, HumanTicketView, OperatorStatus } from '../types/desk';

/** A ticket as the desk holds it: the server view plus when this browser received it. */
export interface DeskTicket {
  ticket: HumanTicketView;
  receivedAt: number;
}

/** Active tickets only: a released or expired ticket leaves the queue list. */
const ACTIVE = new Set(['waiting', 'offered']);

/** `m:ss`, or `h:mm:ss` past an hour. Wait clocks tick every second, so this is fixed-width. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** Server `waitMs` is the baseline; the browser clock only adds the time since it was received. */
export function ticketWaitMs(entry: DeskTicket, now: number): number {
  return entry.ticket.waitMs + Math.max(0, now - entry.receivedAt);
}

/** Milliseconds left of an offer to this operator, or undefined when none is outstanding. */
export function offerRemainingMs(ticket: HumanTicketView, now: number): number | undefined {
  if (!ticket.offeredToMe || !ticket.offerExpiresAt) return undefined;
  return Math.max(0, Date.parse(ticket.offerExpiresAt) - now);
}

/** The state badge's text for the operator looking at the row. */
export function ticketStateLabel(ticket: HumanTicketView, now: number): string {
  const remaining = offerRemainingMs(ticket, now);
  if (remaining !== undefined) return `Offered to you ${formatClock(remaining)}`;
  if (ticket.status === 'accepted') return 'Taken';
  if (ticket.status === 'offered') return 'Offered';
  return 'Waiting';
}

/** Sorted the way an operator should take them: priority first, then the longest wait. */
export function sortQueue(entries: readonly DeskTicket[]): DeskTicket[] {
  return [...entries].sort(
    (a, b) =>
      b.ticket.priority - a.ticket.priority ||
      Date.parse(a.ticket.createdAt) - Date.parse(b.ticket.createdAt),
  );
}

export interface DeskState {
  tickets: ReadonlyMap<string, DeskTicket>;
  me?: DeskMe;
}

/** Applies one stream event; returns the same object when nothing changed. */
export function applyDeskEvent(state: DeskState, event: DeskStreamEvent, now: number): DeskState {
  if (event.type === 'ticket') {
    const next = new Map(state.tickets);
    // A newer version of a ticket supersedes an older one; a stale replay after resume is ignored.
    const known = next.get(event.ticket.id);
    if (known && known.ticket.version > event.ticket.version) return state;
    next.set(event.ticket.id, { ticket: event.ticket, receivedAt: now });
    return { ...state, tickets: next };
  }
  if (event.type === 'removed') {
    if (!state.tickets.has(event.id)) return state;
    const next = new Map(state.tickets);
    next.delete(event.id);
    return { ...state, tickets: next };
  }
  if (event.type === 'me' && state.me)
    return {
      ...state,
      me: {
        ...state.me,
        ...event.me,
        stats: { ...state.me.stats, ...event.me.stats },
      },
    };
  return state;
}

/** Replaces the whole set from a list fetch (first load, or after a `gap`). */
export function replaceTickets(
  tickets: readonly HumanTicketView[],
  now: number,
): DeskState['tickets'] {
  return new Map(tickets.map((ticket) => [ticket.id, { ticket, receivedAt: now }]));
}

export interface DeskKpis {
  waiting: number | null;
  longestWaitMs: number | null;
  mine: number | null;
  online: number | null;
  handledToday: number | null;
}

/** Tiles read `null` ("—") whenever the stream is down: unknown is never shown as zero. */
export function deskKpis(state: DeskState, options: { live: boolean; now: number }): DeskKpis {
  const waiting = [...state.tickets.values()].filter((entry) => ACTIVE.has(entry.ticket.status));
  const known = options.live && state.me !== undefined;
  return {
    waiting: options.live ? waiting.length : null,
    longestWaitMs: options.live
      ? waiting.reduce((max, entry) => Math.max(max, ticketWaitMs(entry, options.now)), 0)
      : null,
    mine: known ? state.me!.stats.activeNow : null,
    online: known ? state.me!.stats.onlineOperators : null,
    handledToday: known ? state.me!.stats.handledToday : null,
  };
}

/** The rows of the queue table: waiting and offered tickets, best first. */
export function queueRows(state: DeskState): DeskTicket[] {
  return sortQueue([...state.tickets.values()].filter((entry) => ACTIVE.has(entry.ticket.status)));
}

/** Whether an operator in this status may take a call, and the reason the button gives if not. */
export function acceptBlock(options: {
  status: OperatorStatus | undefined;
  hasActiveCall: boolean;
  wrapUpPending: boolean;
  roomReachable: boolean | undefined;
}): string | undefined {
  if (options.roomReachable === false) return 'Calls cannot be answered in the browser right now.';
  if (options.status !== 'AVAILABLE') return 'Set yourself Available to accept calls.';
  if (options.hasActiveCall) return 'Finish your current call first.';
  if (options.wrapUpPending) return 'Complete wrap-up for your last call first.';
  return undefined;
}

/** The first offered-to-me ticket, else the first waiting one: the target of the A shortcut. */
export function nextToAccept(rows: readonly DeskTicket[]): HumanTicketView | undefined {
  return (rows.find((entry) => entry.ticket.offeredToMe) ?? rows[0])?.ticket;
}
