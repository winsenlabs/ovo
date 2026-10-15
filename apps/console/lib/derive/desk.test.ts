import { describe, expect, it } from 'vitest';
import {
  acceptBlock,
  applyDeskEvent,
  deskKpis,
  formatClock,
  nextToAccept,
  offerRemainingMs,
  queueRows,
  replaceTickets,
  ticketStateLabel,
  ticketWaitMs,
  type DeskState,
} from './desk';
import type { DeskMe, HumanTicketView } from '../types/desk';

const ticket = (id: string, patch: Partial<HumanTicketView> = {}): HumanTicketView => ({
  id,
  queueId: 'q1',
  queueKey: 'support',
  queueName: 'Support desk',
  kind: 'managed',
  mode: 'OPEN_PICKUP',
  status: 'waiting',
  version: 1,
  priority: 0,
  createdAt: '2026-10-15T10:00:00.000Z',
  waitMs: 5_000,
  offeredToMe: false,
  ...patch,
});

const me: DeskMe = {
  profile: { userId: 'u1', displayName: 'Asha', enabled: true, teamIds: [], languages: ['en'], capacity: 1 },
  status: 'AVAILABLE',
  queues: [],
  roomProvider: { provider: 'fake', serverUrl: 'wss://room.test' },
  presenceTtlSeconds: 30,
  stats: { handledToday: 4, activeNow: 1, onlineOperators: 3 },
};

describe('formatClock', () => {
  it('is m:ss and h:mm:ss, never negative', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(14_900)).toBe('0:14');
    expect(formatClock(61_000)).toBe('1:01');
    expect(formatClock(3_725_000)).toBe('1:02:05');
    expect(formatClock(-5)).toBe('0:00');
  });
});

describe('wait and offer clocks', () => {
  it('adds only the time since receipt to the server baseline', () => {
    const entry = { ticket: ticket('a', { waitMs: 5_000 }), receivedAt: 1_000 };
    expect(ticketWaitMs(entry, 4_000)).toBe(8_000);
    expect(ticketWaitMs(entry, 500)).toBe(5_000);
  });
  it('counts an offer down to zero and labels it for the operator', () => {
    const offered = ticket('a', {
      status: 'offered',
      offeredToMe: true,
      offerExpiresAt: new Date(20_000).toISOString(),
    });
    expect(offerRemainingMs(offered, 6_000)).toBe(14_000);
    expect(ticketStateLabel(offered, 6_000)).toBe('Offered to you 0:14');
    expect(offerRemainingMs(offered, 99_000)).toBe(0);
    expect(offerRemainingMs(ticket('b'), 0)).toBeUndefined();
    expect(ticketStateLabel(ticket('b', { status: 'offered' }), 0)).toBe('Offered');
    expect(ticketStateLabel(ticket('c'), 0)).toBe('Waiting');
    expect(ticketStateLabel(ticket('d', { status: 'accepted' }), 0)).toBe('Taken');
  });
});

describe('applyDeskEvent', () => {
  const base = (): DeskState => ({ tickets: replaceTickets([ticket('a')], 0), me });

  it('adds a ticket and lets a newer version replace it', () => {
    const added = applyDeskEvent(base(), { type: 'ticket', ticket: ticket('b') }, 10);
    expect([...added.tickets.keys()]).toEqual(['a', 'b']);
    const newer = applyDeskEvent(added, { type: 'ticket', ticket: ticket('b', { version: 2, status: 'accepted' }) }, 20);
    expect(newer.tickets.get('b')?.ticket.status).toBe('accepted');
    expect(newer.tickets.get('b')?.receivedAt).toBe(20);
  });

  it('ignores a replayed older version after a resume', () => {
    const state = applyDeskEvent(base(), { type: 'ticket', ticket: ticket('a', { version: 3 }) }, 1);
    expect(applyDeskEvent(state, { type: 'ticket', ticket: ticket('a', { version: 2 }) }, 2)).toBe(state);
  });

  it('removes a ticket, and is a no-op for one it never had', () => {
    const state = base();
    expect(applyDeskEvent(state, { type: 'removed', id: 'a' }, 0).tickets.size).toBe(0);
    expect(applyDeskEvent(state, { type: 'removed', id: 'zzz' }, 0)).toBe(state);
  });

  it('merges a partial me update and leaves heartbeats alone', () => {
    const next = applyDeskEvent(base(), { type: 'me', me: { status: 'AWAY', stats: { handledToday: 9 } as DeskMe['stats'] } }, 0);
    expect(next.me?.status).toBe('AWAY');
    expect(next.me?.stats).toEqual({ handledToday: 9, activeNow: 1, onlineOperators: 3 });
    const state = base();
    expect(applyDeskEvent(state, { type: 'heartbeat' }, 0)).toBe(state);
    expect(applyDeskEvent(state, { type: 'gap' }, 0)).toBe(state);
  });
});

describe('queue rows and KPIs', () => {
  const state: DeskState = {
    me,
    tickets: replaceTickets(
      [
        ticket('old', { createdAt: '2026-10-15T09:00:00.000Z' }),
        ticket('vip', { priority: 2, createdAt: '2026-10-15T09:30:00.000Z' }),
        ticket('mine', { status: 'accepted' }),
        ticket('done', { status: 'released' }),
      ],
      0,
    ),
  };

  it('lists waiting and offered tickets, highest priority then longest wait first', () => {
    expect(queueRows(state).map((entry) => entry.ticket.id)).toEqual(['vip', 'old']);
  });

  it('reports unknown, not zero, whenever the stream is down', () => {
    expect(deskKpis(state, { live: false, now: 0 })).toEqual({
      waiting: null,
      longestWaitMs: null,
      mine: null,
      online: null,
      handledToday: null,
    });
    expect(deskKpis(state, { live: true, now: 5_000 })).toEqual({
      waiting: 2,
      longestWaitMs: 10_000,
      mine: 1,
      online: 3,
      handledToday: 4,
    });
  });

  it('picks the offered-to-me ticket before the first waiting one', () => {
    const rows = queueRows({
      me,
      tickets: replaceTickets([ticket('x', { priority: 5 }), ticket('y', { status: 'offered', offeredToMe: true })], 0),
    });
    expect(nextToAccept(rows)?.id).toBe('y');
    expect(nextToAccept([])).toBeUndefined();
  });
});

describe('acceptBlock', () => {
  const ok = { status: 'AVAILABLE' as const, hasActiveCall: false, wrapUpPending: false, roomReachable: true };
  it('allows an available operator with a free line', () => {
    expect(acceptBlock(ok)).toBeUndefined();
    expect(acceptBlock({ ...ok, roomReachable: undefined })).toBeUndefined();
  });
  it('says why, most fundamental reason first', () => {
    expect(acceptBlock({ ...ok, roomReachable: false })).toMatch(/browser right now/);
    expect(acceptBlock({ ...ok, status: 'AWAY' })).toMatch(/Available/);
    expect(acceptBlock({ ...ok, hasActiveCall: true })).toMatch(/current call/);
    expect(acceptBlock({ ...ok, wrapUpPending: true })).toMatch(/wrap-up/);
  });
});
