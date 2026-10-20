'use client';
import { useEffect, useRef, useState } from 'react';
export type StreamState<T> = { events: T[]; status: 'connecting' | 'live' | 'stale' | 'closed'; cursor?: string };
export function mergeStreamEvent<T>(state: StreamState<T>, event: T, cursor?: string): StreamState<T> {
  if (cursor && state.cursor === cursor) return state;
  return { ...state, events: [...state.events, event], cursor: cursor ?? state.cursor, status: 'live' };
}
export function useEventStream<T = unknown>(path?: string, heartbeatMs = 15_000) {
  const [state, setState] = useState<StreamState<T> & { path?: string }>({ path, events: [], status: path ? 'connecting' : 'closed' });
  const cursor = useRef<string | undefined>(undefined);
  const activePath = useRef(path);
  useEffect(() => {
    if (activePath.current !== path) {
      activePath.current = path;
      cursor.current = undefined;
      setState({ path, events: [], status: path ? 'connecting' : 'closed' });
    }
    if (!path) return;
    let current = true;
    let source: EventSource;
    let retry: ReturnType<typeof setTimeout>;
    let lastLiveness = Date.now();
    const connect = () => {
      const url = new URL(path, window.location.origin);
      if (cursor.current) url.searchParams.set('cursor', cursor.current);
      source = new EventSource(url.pathname + url.search, { withCredentials: true });
      const receive = (event: MessageEvent) => {
        if (!current) return;
        try {
          const value = JSON.parse(event.data) as T;
          const id = event.lastEventId || (value && typeof value === 'object' && 'eventId' in value ? String(value.eventId) : undefined);
          if (id) cursor.current = id;
          lastLiveness = Date.now();
          setState(previous => ({ ...mergeStreamEvent(previous, value, id), path }));
        } catch { /* Ignore malformed replay item; preserve live stream. */ }
      };
      source.onmessage = receive;
      for (const name of ['transcript', 'turn', 'timing', 'speech', 'end', 'stage', 'cost']) source.addEventListener(name, receive as EventListener);
      source.addEventListener('heartbeat', () => { if (!current) return; lastLiveness = Date.now(); setState(previous => ({ ...previous, status: 'live' })); });
      source.onerror = () => { source.close(); if (current) { setState(previous => ({ ...previous, status: 'stale' })); retry = setTimeout(connect, 1000); } };
      source.onopen = () => { if (!current) return; lastLiveness = Date.now(); setState(previous => ({ ...previous, status: 'live' })); };
    };
    connect();
    const watchdog = setInterval(() => { if (current && Date.now() - lastLiveness > heartbeatMs * 2) setState(previous => ({ ...previous, status: 'stale' })); }, heartbeatMs);
    return () => { current = false; source?.close(); clearTimeout(retry); clearInterval(watchdog); };
  }, [path, heartbeatMs]);
  return state.path === path ? state : { events: [], status: path ? 'connecting' : 'closed' } as StreamState<T>;
}
