import type {
  EventSink,
  RouteContext,
  RouterEntry,
  RoutingHost,
  RoutingPoolTarget,
  SegmentHandoffPort,
} from '@winsendotai/ovo-contracts';
import type { DisclosurePart } from './disclosure.ts';
import type { EngineRunners } from './engines/index.ts';

/** A pool target about to claim a member: the node and turn it belongs to and the route so far. */
export interface PoolAttempt {
  turn: number;
  node: string;
  target: RoutingPoolTarget;
  context: RouteContext;
}

/** What the router core is given: the host, the handoff port, the engines and (R2) its entry. */
export interface RouterPorts {
  host: RoutingHost;
  handoff: SegmentHandoffPort;
  /** One runner per engine kind: `createEngineRunners` in production, scripted in a simulator. */
  runners: EngineRunners;
  events?: EventSink;
  /** The router agent's IANA zone, which a promised callback's due time is recorded in. */
  timezone?: string;
  /** R2: the router release's disclosure parts, said before the greeting when the host has `begin`. */
  disclosure?: readonly DisclosurePart[];
  /** R2 §7.5: a re-routed router resumes here instead of greeting. */
  entry?: RouterEntry;
  /** Observes each pool target as it is attempted, before the claim. A simulator explains the pick with it. */
  onPool?: (attempt: PoolAttempt) => void;
}

/** `routing` until the route is decided; then `announcing` (a handoff) or `ended` (end, callback). */
export type RouterPhase = 'routing' | 'announcing' | 'ended';

export interface RouterReply {
  say: string;
  phase: RouterPhase;
}
