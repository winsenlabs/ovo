import type {
  EventSink,
  RouterEntry,
  RoutingHost,
  SegmentHandoffPort,
} from '@winsendotai/ovo-contracts';
import type { DisclosurePart } from './disclosure.ts';
import type { EngineRunners } from './engines/index.ts';

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
}

/** `routing` until the route is decided; then `announcing` (a handoff) or `ended` (end, callback). */
export type RouterPhase = 'routing' | 'announcing' | 'ended';

export interface RouterReply {
  say: string;
  phase: RouterPhase;
}
