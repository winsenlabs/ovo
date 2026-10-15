import type {
  CallbackRequest,
  DisclosureKind,
  EventSink,
  RouteDecisionPayload,
  RouteFallbackPayload,
  RouteNodePayload,
} from '@winsendotai/ovo-contracts';

export interface RecordedRouteEvent {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Where the router records what it decided (§4.9): `route.node` per engine attempt, `route.fallback`
 * per fallback step, one `route.decision`, a `disposition` for an end with a disposition or a
 * callback, and (R2) a `disclosure` once the router's disclosure was heard. Every event is also kept in `events`, in order, for the simulator and the replay tests.
 * Appending never waits and never throws into the call: the sink queues (AGT-8). No caller words and
 * no phone numbers are ever put in a payload.
 */
export class RouteRecorder {
  readonly events: RecordedRouteEvent[] = [];

  constructor(private readonly sink?: EventSink) {}

  node(payload: RouteNodePayload): void {
    this.record('route.node', payload);
  }

  fallback(payload: RouteFallbackPayload): void {
    this.record('route.fallback', payload);
  }

  decision(payload: RouteDecisionPayload): void {
    this.record('route.decision', payload);
  }

  disposition(payload: {
    disposition: string;
    turn: number;
    node: string;
    reason: string;
    callback?: CallbackRequest;
  }): void {
    this.record('disposition', { ...payload, source: 'system' });
  }

  /** R2: the router's disclosure was heard in full (`RouterDisclosure`). */
  disclosure(payload: { kinds: DisclosureKind[] }): void {
    this.record('disclosure', payload);
  }

  private record(type: string, payload: Record<string, unknown>): void {
    this.events.push({ type, payload });
    // swallow-ok: a sink reports and drops a bad event itself; the call never waits on storage.
    if (this.sink) void this.sink.append(type, payload).catch(() => undefined);
  }
}
