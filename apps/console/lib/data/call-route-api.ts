'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadAgentChoices } from '../../components/operations/agent-release-options';
import { ApiError, apiRequest, items } from '../api';
import { hasRouteData } from '../derive/call-route-summary';
import {
  ROUTE_EVENT_CAP,
  type CallRouteResponse,
  type HumanDetails,
  type PayloadRecord,
  type RouteEvent,
  type RoutingPointOption,
  type RoutingStatusLite,
  type RouteSegmentRow,
  type RouteTransferPair,
  type SegmentCost,
} from '../types/call-route';

const record = (value: unknown): value is PayloadRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readEvents(raw: unknown): RouteEvent[] {
  if (!Array.isArray(raw)) return [];
  const events: RouteEvent[] = [];
  for (const entry of raw) {
    if (!record(entry) || typeof entry.type !== 'string' || typeof entry.at !== 'string') continue;
    if (typeof entry.sequence !== 'number' || !record(entry.payload)) continue;
    events.push({
      sequence: entry.sequence,
      at: entry.at,
      type: entry.type,
      ...(typeof entry.segment === 'number' ? { segment: entry.segment } : {}),
      payload: entry.payload,
    });
  }
  return events.sort((a, b) => a.sequence - b.sequence);
}

function readPairs(raw: unknown): RouteTransferPair[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((pair) =>
    record(pair)
      ? [
          {
            requested: record(pair.requested) ? pair.requested : null,
            completed: record(pair.completed) ? pair.completed : null,
          },
        ]
      : [],
  );
}

/**
 * Shapes whatever the API answered into a `CallRouteResponse`: an older API without `events`, a
 * direct call (no route, no segments) and an installation without outcomes all read the same way.
 */
export function normaliseCallRoute(raw: unknown, callId: string): CallRouteResponse {
  const body = record(raw) ? raw : {};
  const events = readEvents(body.events);
  return {
    callId: typeof body.callId === 'string' ? body.callId : callId,
    available: body.available !== false,
    route: record(body.route) ? (body.route as unknown as CallRouteResponse['route']) : null,
    segments: Array.isArray(body.segments) ? (body.segments as RouteSegmentRow[]) : [],
    human: record(body.human) ? (body.human as unknown as HumanDetails) : null,
    transfers: readPairs(body.transfers),
    callLevelCost: record(body.callLevelCost) ? (body.callLevelCost as unknown as SegmentCost) : null,
    events,
    eventsTruncated: body.eventsTruncated === true || events.length >= ROUTE_EVENT_CAP,
  };
}

export const callRouteApi = {
  segments: async (callId: string) =>
    normaliseCallRoute(
      (await apiRequest<unknown>(`/calls/${encodeURIComponent(callId)}/segments`)).data,
      callId,
    ),
};

export type CallRouteState =
  | { status: 'loading' }
  | { status: 'ready'; data: CallRouteResponse }
  | { status: 'error'; error: ApiError | Error };

/** The call's route and segments, loaded once per call and reloadable (Retry). */
export function useCallRoute(callId: string): CallRouteState & { refresh: () => void } {
  const [state, setState] = useState<CallRouteState>({ status: 'loading' });
  const generation = useRef(0);
  const refresh = useCallback(() => {
    const request = ++generation.current;
    setState({ status: 'loading' });
    callRouteApi
      .segments(callId)
      .then((data) => generation.current === request && setState({ status: 'ready', data }))
      .catch(
        (failure) =>
          generation.current === request &&
          setState({
            status: 'error',
            error: failure instanceof Error ? failure : new Error('Route data unavailable'),
          }),
      );
  }, [callId]);
  useEffect(() => {
    refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);
  return { ...state, refresh };
}

/** Whether routing is switched on here; any failure reads as "off" so the filters stay hidden. */
export async function loadRoutingStatus(): Promise<RoutingStatusLite> {
  const { data } = await apiRequest<unknown>('/routing/status');
  const body = record(data) ? data : {};
  return {
    enabled: body.enabled === true,
    humanQueueEnabled: body.humanQueueEnabled === true,
    transferEnabled: body.transferEnabled === true,
    outcomesAvailable: typeof body.outcomesAvailable === 'boolean' ? body.outcomesAvailable : null,
  };
}

/** Routing points for a filter select (up to 100); a dark feature answers with none. */
export async function loadRoutingPoints(): Promise<RoutingPointOption[]> {
  try {
    const { data } = await apiRequest<unknown>('/routing/points?limit=100');
    return items<{ id: string; draft?: { name?: string } }>(data).map((point) => ({
      id: point.id,
      name: point.draft?.name ?? point.id,
    }));
  } catch (failure) {
    if (failure instanceof ApiError && failure.status === 404) return [];
    throw failure;
  }
}

const NO_NAMES: ReadonlyMap<string, string> = new Map();

/** Agent names by id, loaded once a call turns out to be routed; ids stand in until they arrive. */
export function useAgentNames(enabled: boolean): ReadonlyMap<string, string> {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(NO_NAMES);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void loadAgentChoices()
      .then((choices) => current && setNames(new Map(choices.map((c) => [c.id, c.name]))))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [enabled]);
  return names;
}

/**
 * Whether the inspector offers the tab. A routed call has one; an installation that cannot say
 * (outcomes not stored) has one that explains it; a direct call has none. While the first load is
 * running the tab only stays when it is the one the URL asked for, and an API without the route
 * (404) hides it rather than showing an error nobody can act on.
 */
export function routeTabVisible(route: CallRouteState, selected: boolean): boolean {
  if (route.status === 'loading') return selected;
  if (route.status === 'error')
    return !(route.error instanceof ApiError && route.error.status === 404);
  return !route.data.available || hasRouteData(route.data);
}

/** The route of a call, the agent names its segments need, and whether the inspector offers the tab. */
export function useCallRouteView(callId: string, tabSelected: boolean) {
  const route = useCallRoute(callId);
  const names = useAgentNames(route.status === 'ready' && hasRouteData(route.data));
  return { route, names, tabVisible: routeTabVisible(route, tabSelected) };
}
