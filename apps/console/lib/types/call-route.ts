// Wire shapes of `GET /v1/calls/:id/segments` (Wave 16, extended in Wave 18 with `events`) and the
// routing facts the Calls list reads off a call's outcome. The inspector shows what the API
// already recorded: ids, keys, codes and timings, never caller words or phone numbers.
import type {
  CallOutcomeHuman,
  CallOutcomeRoute,
  CallOutcomeSegment,
} from '@winsendotai/ovo-contracts';

export type SegmentRole = CallOutcomeSegment['role'];
export const SEGMENT_ROLES: readonly SegmentRole[] = ['router', 'agent', 'human'];

/** The ledger's rounded totals of one segment (paise, as decimal strings). */
export interface SegmentCost {
  currency: string;
  estimatedPaise: string;
  reconciledPaise: string;
  totalPaise: string;
}

/** What the API tells about the person segment: never a caller number, destination or summary. */
export interface HumanDetails {
  queue: string;
  queueId: string;
  kind: CallOutcomeHuman['kind'];
  ticket: string;
  waitMs: number | null;
  talkMs: number | null;
  operator: string | null;
  outcome: CallOutcomeHuman['outcome'];
  /** Present once the API folds third-party callbacks into this view; else read from events. */
  callbacks?: CallOutcomeHuman['callbacks'];
}

export interface RouteSegmentRow extends CallOutcomeSegment {
  cost: SegmentCost | null;
  human?: HumanDetails;
}

/** The route as folded from `route.decision` (R4 adds the optional counters). */
export type CallRouteInfo = CallOutcomeRoute & {
  turns?: number | null;
  routeMs?: number | null;
  fallbacks?: number;
  reasks?: number;
};

export type PayloadRecord = Record<string, unknown>;

/** One allowlisted session event (`route.*`, `transfer.*`, `segment.ended`, `disclosure`, ...). */
export interface RouteEvent {
  sequence: number;
  at: string;
  type: string;
  /** The routing segment the event belongs to, when the API could tell. */
  segment?: number;
  payload: PayloadRecord;
}

/** A transfer request and, once an accepted request completed, how it ended. */
export interface RouteTransferPair {
  requested: PayloadRecord | null;
  completed: PayloadRecord | null;
}

export interface CallRouteResponse {
  callId: string;
  /** False when this installation does not store call outcomes. */
  available: boolean;
  route: CallRouteInfo | null;
  segments: RouteSegmentRow[];
  human: HumanDetails | null;
  transfers: RouteTransferPair[];
  callLevelCost: SegmentCost | null;
  events: RouteEvent[];
  /** The API caps the events; true (or a full page) means the list is the first part only. */
  eventsTruncated: boolean;
}

/** Events the API returns at most (design section 6). */
export const ROUTE_EVENT_CAP = 400;

/** The routing status the Calls list reads to decide whether routing filters make sense. */
export interface RoutingStatusLite {
  enabled: boolean;
  humanQueueEnabled: boolean;
  transferEnabled: boolean;
  outcomesAvailable: boolean | null;
}

export type RoutingPointOption = { id: string; name: string };

/** A line of the transcript that carries the routing segment it was spoken in (R4 evidence). */
export type SegmentTagged = { segment?: number };
