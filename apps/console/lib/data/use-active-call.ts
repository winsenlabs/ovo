'use client';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  classifyMicrophoneFailure,
  createRoomClient,
  type RoomClient,
  type RoomConnectionState,
  type RoomGrant,
  type RoomLevels,
} from '@winsendotai/ovo-ui/room';
import { applyCaption, type CaptionLine } from '../derive/captions';
import type { DeskTicket } from '../derive/desk';
import type { DeskAcceptResult, DeskMe, HumanTicketView, TicketContext } from '../types/desk';
import { deskApi, type WrapUp } from './desk-api';

export type CallPhase = 'connecting' | 'live' | 'ended';

export interface ActiveCallState {
  phase: CallPhase;
  ticket: HumanTicketView;
  context?: TicketContext;
  startedAt: number;
  connection: RoomConnectionState;
  callerPresent: boolean;
  captions: CaptionLine[];
  muted: boolean;
  volume: number;
  /** Why the room is unusable (token expired, server down); the call can be retried. */
  roomError?: string;
  /** Set once the call is over: how, and whether wrap-up is still owed. */
  ended?: { reason: string; wrapUpDone: boolean };
}

type Action =
  | { type: 'start'; ticket: HumanTicketView; context?: TicketContext; now: number }
  | { type: 'context'; context: TicketContext }
  | { type: 'connection'; connection: RoomConnectionState }
  | { type: 'caller'; present: boolean }
  | { type: 'caption'; captions: CaptionLine[] }
  | { type: 'roomError'; message?: string }
  | { type: 'muted'; muted: boolean }
  | { type: 'volume'; volume: number }
  | { type: 'ended'; reason: string }
  | { type: 'wrapped' }
  | { type: 'clear' };

function reduce(state: ActiveCallState | undefined, action: Action): ActiveCallState | undefined {
  if (action.type === 'start')
    return {
      phase: 'connecting',
      ticket: action.ticket,
      context: action.context,
      startedAt: action.now,
      connection: 'idle',
      callerPresent: false,
      captions: [],
      muted: false,
      volume: 1,
    };
  if (action.type === 'clear' || !state) return undefined;
  switch (action.type) {
    case 'context':
      return { ...state, context: action.context };
    case 'connection': {
      const live = action.connection === 'connected' && state.callerPresent;
      return {
        ...state,
        connection: action.connection,
        phase: state.phase === 'ended' ? 'ended' : live ? 'live' : 'connecting',
      };
    }
    case 'caller':
      return {
        ...state,
        callerPresent: action.present,
        phase:
          state.phase === 'ended'
            ? 'ended'
            : action.present && state.connection === 'connected'
              ? 'live'
              : 'connecting',
      };
    case 'caption':
      return { ...state, captions: action.captions };
    case 'roomError':
      return { ...state, roomError: action.message };
    case 'muted':
      return { ...state, muted: action.muted };
    case 'volume':
      return { ...state, volume: action.volume };
    case 'ended':
      return state.phase === 'ended'
        ? state
        : { ...state, phase: 'ended', ended: { reason: action.reason, wrapUpDone: false } };
    case 'wrapped':
      return state.ended ? { ...state, ended: { ...state.ended, wrapUpDone: true } } : state;
  }
}

const DEAD_LEVELS: RoomLevels = { input: 0, output: 0 };

/**
 * The operator's one active call: the room connection, live captions, the call controls and the
 * end of the call. The desk holds at most one. `tickets` is the desk's view of every ticket, so a
 * call the server ended (caller hung up, sweeper, admin) ends here too.
 */
export function useActiveCall(options: {
  me: DeskMe | undefined;
  tickets: ReadonlyMap<string, DeskTicket>;
  onCommandError?: (message: string) => void;
}) {
  const [call, dispatch] = useReducer(reduce, undefined);
  const client = useRef<RoomClient>(undefined);
  const captions = useRef<CaptionLine[]>([]);
  const active = useRef(call);
  active.current = call;
  const provider = options.me?.roomProvider.provider;

  const leaveRoom = useCallback(async () => {
    const current = client.current;
    client.current = undefined;
    await current?.disconnect().catch(() => undefined);
  }, []);

  const join = useCallback(
    async (grant: RoomGrant) => {
      await leaveRoom();
      const next = await createRoomClient(provider ?? grant.provider);
      client.current = next;
      next.onState((connection) => dispatch({ type: 'connection', connection }));
      next.onCallerPresent((present) => dispatch({ type: 'caller', present }));
      next.onCaption((caption) => {
        captions.current = applyCaption(captions.current, caption);
        dispatch({ type: 'caption', captions: captions.current });
      });
      try {
        await next.connect(grant);
        dispatch({ type: 'roomError' });
      } catch (failure) {
        dispatch({
          type: 'roomError',
          message:
            classifyMicrophoneFailure(failure) === 'denied'
              ? 'Microphone access is blocked. Allow it in the browser settings, then retry.'
              : failure instanceof Error
                ? failure.message
                : 'The room could not be joined.',
        });
      }
    },
    [leaveRoom, provider],
  );

  const start = useCallback(
    async (result: DeskAcceptResult) => {
      captions.current = [];
      dispatch({ type: 'start', ticket: result.ticket, context: result.context, now: Date.now() });
      await join(result.room);
    },
    [join],
  );

  /** A reload with an accepted call still open: fetch the context, mint a fresh token, rejoin. */
  const resume = useCallback(
    async (ticket: HumanTicketView) => {
      captions.current = [];
      dispatch({ type: 'start', ticket, now: Date.now() });
      try {
        const [context, room] = await Promise.all([
          deskApi.context(ticket.id),
          deskApi.token(ticket.id),
        ]);
        dispatch({ type: 'context', context });
        await join(room);
      } catch (failure) {
        dispatch({
          type: 'roomError',
          message: failure instanceof Error ? failure.message : 'The call could not be resumed.',
        });
      }
    },
    [join],
  );

  /** The token lives 120 s; a rejoin after a drop asks for a new one. */
  const reconnect = useCallback(async () => {
    const ticket = active.current?.ticket;
    if (!ticket) return;
    dispatch({ type: 'roomError' });
    try {
      await join(await deskApi.token(ticket.id));
    } catch (failure) {
      dispatch({
        type: 'roomError',
        message: failure instanceof Error ? failure.message : 'The room could not be rejoined.',
      });
    }
  }, [join]);

  const command = useCallback(
    async (body: Parameters<typeof deskApi.command>[1], reason: string) => {
      const ticket = active.current?.ticket;
      if (!ticket) return false;
      try {
        await deskApi.command(ticket.id, body);
      } catch (failure) {
        options.onCommandError?.(
          failure instanceof Error ? failure.message : 'The command failed.',
        );
        return false;
      }
      await leaveRoom();
      dispatch({ type: 'ended', reason });
      return true;
    },
    [leaveRoom, options],
  );

  const wrapUp = useCallback(
    async (wrap: WrapUp) => {
      const ticket = active.current?.ticket;
      if (!ticket) return false;
      try {
        await deskApi.wrapUp(ticket.id, wrap);
      } catch (failure) {
        options.onCommandError?.(failure instanceof Error ? failure.message : 'Wrap-up failed.');
        return false;
      }
      dispatch({ type: 'wrapped' });
      return true;
    },
    [options],
  );

  const callId = call?.ticket.id;
  const remote = callId ? options.tickets.get(callId)?.ticket : undefined;
  useEffect(() => {
    if (!callId) return;
    if (!remote || remote.status === 'released' || remote.status === 'expired') {
      void leaveRoom();
      dispatch({ type: 'ended', reason: remote?.releaseCode ?? remote?.status ?? 'released' });
    }
  }, [callId, remote, leaveRoom]);

  useEffect(() => () => void client.current?.disconnect().catch(() => undefined), []);

  return {
    call,
    start,
    resume,
    reconnect,
    hangUp: () => command({ kind: 'end_call' }, 'ended_by_operator'),
    sendBack: (target: string) => command({ kind: 'return_to_agent', target }, 'returned'),
    wrapUp,
    dismiss: async () => {
      await leaveRoom();
      dispatch({ type: 'clear' });
    },
    setMuted: async (muted: boolean) => {
      await client.current?.setMuted(muted);
      dispatch({ type: 'muted', muted });
    },
    setVolume: (volume: number) => {
      client.current?.setVolume(volume);
      dispatch({ type: 'volume', volume });
    },
    setInputDevice: (id: string) => client.current?.setInputDevice(id),
    setOutputDevice: (id: string) => client.current?.setOutputDevice(id),
    levels: () => client.current?.levels() ?? DEAD_LEVELS,
  };
}
