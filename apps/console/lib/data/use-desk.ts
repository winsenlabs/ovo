'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../api';
import {
  applyDeskEvent,
  queueRows,
  replaceTickets,
  type DeskState,
  type DeskTicket,
} from '../derive/desk';
import type {
  DeskAcceptResult,
  DeskMe,
  HumanTicketView,
  OperatorStatus,
} from '../types/desk';
import { deskApi } from './desk-api';
import { openDeskStream, type DeskStreamStatus } from './desk-stream';

export type DeskPhase = 'loading' | 'ready' | 'disabled' | 'not_operator' | 'error';

/** How an accept ended. Everything but `accepted` leaves the operator on the queue. */
export type AcceptOutcome =
  | { kind: 'accepted'; result: DeskAcceptResult }
  | { kind: 'conflict' | 'at_capacity' | 'not_eligible' | 'room_unavailable' }
  | { kind: 'error'; message: string };

const HEARTBEAT_MS = 10_000;

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * The desk's live state: who I am, the queue, my own tickets and the stream that keeps them
 * current. The stream is open only while I am Available or Away (or holding a call); a heartbeat
 * every 10 s keeps presence from lapsing; tickets are reloaded whenever the server reports a gap.
 */
export function useDesk() {
  const [phase, setPhase] = useState<DeskPhase>('loading');
  const [error, setError] = useState<string>();
  const [state, setState] = useState<DeskState>({ tickets: new Map() });
  const [roomReachable, setRoomReachable] = useState<boolean>();
  const [stream, setStream] = useState<DeskStreamStatus>('closed');
  const [notice, setNotice] = useState<{ tone: 'info' | 'warn' | 'danger'; text: string }>();
  const userId = useRef<string>('');

  const loadTickets = useCallback(async () => {
    const [queue, mine] = await Promise.all([deskApi.tickets('queue'), deskApi.tickets('mine')]);
    const merged = new Map<string, HumanTicketView>();
    for (const ticket of [...queue, ...mine]) merged.set(ticket.id, ticket);
    setState((previous) => ({
      ...previous,
      tickets: replaceTickets([...merged.values()], Date.now()),
    }));
  }, []);

  const load = useCallback(async () => {
    setPhase('loading');
    try {
      const me = await deskApi.me();
      userId.current = me.profile.userId;
      setState((previous) => ({ ...previous, me }));
      const [, room] = await Promise.all([
        loadTickets(),
        deskApi.roomStatus().catch(() => undefined),
      ]);
      setRoomReachable(room ? (room.managedAvailable && room.room.reachable !== false) : undefined);
      setError(undefined);
      setPhase('ready');
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'human_queue_disabled')
        return void setPhase('disabled');
      if (failure instanceof ApiError && failure.code === 'operator_profile_required')
        return void setPhase('not_operator');
      setError(failureMessage(failure, 'The operator desk could not be loaded.'));
      setPhase('error');
    }
  }, [loadTickets]);

  useEffect(() => {
    void load();
  }, [load]);

  const status = state.me?.status;
  const mine = useMemo(
    () =>
      [...state.tickets.values()]
        .map((entry) => entry.ticket)
        .filter(
          (ticket) => ticket.status === 'accepted' && ticket.assignedOperatorId === userId.current,
        ),
    [state.tickets, phase],
  );
  const streaming = phase === 'ready' && (status !== 'OFFLINE' || mine.length > 0);

  useEffect(() => {
    if (!streaming) return;
    return openDeskStream({
      url: '/api/v1/desk/stream',
      onStatus: setStream,
      onEvent: (event) => {
        if (event.type === 'gap') void loadTickets().catch(() => undefined);
        else setState((previous) => applyDeskEvent(previous, event, Date.now()));
      },
    });
  }, [streaming, loadTickets]);

  useEffect(() => {
    if (status !== 'AVAILABLE' && status !== 'AWAY') return;
    const timer = setInterval(() => void deskApi.heartbeat().catch(() => undefined), HEARTBEAT_MS);
    // Closing the tab goes Offline at once instead of lapsing after the presence TTL.
    const leave = () =>
      void fetch('/api/v1/desk/presence', {
        method: 'PUT',
        keepalive: true,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'OFFLINE' }),
      }).catch(() => undefined);
    window.addEventListener('pagehide', leave);
    return () => {
      clearInterval(timer);
      window.removeEventListener('pagehide', leave);
    };
  }, [status]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 6_000);
    return () => clearTimeout(timer);
  }, [notice]);

  const setStatus = useCallback(
    async (next: OperatorStatus) => {
      const previous = state.me?.status;
      setState((current) => (current.me ? { ...current, me: { ...current.me, status: next } } : current));
      try {
        await deskApi.setPresence(next);
        return true;
      } catch (failure) {
        setState((current) =>
          current.me && previous ? { ...current, me: { ...current.me, status: previous } } : current,
        );
        setNotice({ tone: 'danger', text: failureMessage(failure, 'Presence could not be changed.') });
        return false;
      }
    },
    [state.me?.status],
  );

  const accept = useCallback(
    async (ticket: HumanTicketView): Promise<AcceptOutcome> => {
      try {
        const result = await deskApi.accept(ticket.id, ticket.version, crypto.randomUUID());
        setState((current) =>
          applyDeskEvent(current, { type: 'ticket', ticket: result.ticket }, Date.now()),
        );
        return { kind: 'accepted', result };
      } catch (failure) {
        if (failure instanceof ApiError) {
          if (failure.code === 'conflict') {
            setNotice({ tone: 'warn', text: 'Another operator took this call.' });
            void loadTickets().catch(() => undefined);
            return { kind: 'conflict' };
          }
          if (failure.code === 'at_capacity') return { kind: 'at_capacity' };
          if (failure.code === 'not_eligible') return { kind: 'not_eligible' };
          if (failure.code === 'room_unavailable') {
            setRoomReachable(false);
            return { kind: 'room_unavailable' };
          }
        }
        return { kind: 'error', message: failureMessage(failure, 'The call could not be accepted.') };
      }
    },
    [loadTickets],
  );

  const decline = useCallback(
    async (ticket: HumanTicketView) => {
      try {
        await deskApi.decline(ticket.id, ticket.version);
        setState((current) => applyDeskEvent(current, { type: 'removed', id: ticket.id }, Date.now()));
      } catch (failure) {
        if (failure instanceof ApiError && failure.code === 'conflict') {
          setNotice({ tone: 'warn', text: 'That call changed before you could decline it.' });
          void loadTickets().catch(() => undefined);
        } else setNotice({ tone: 'danger', text: failureMessage(failure, 'Decline failed.') });
      }
    },
    [loadTickets],
  );

  const rows: DeskTicket[] = useMemo(() => queueRows(state), [state]);
  return {
    phase,
    error,
    me: state.me as DeskMe | undefined,
    state,
    rows,
    mine,
    live: stream === 'live',
    stale: stream === 'stale',
    roomReachable,
    notice,
    notify: setNotice,
    dismissNotice: () => setNotice(undefined),
    reload: load,
    setStatus,
    accept,
    decline,
  };
}
