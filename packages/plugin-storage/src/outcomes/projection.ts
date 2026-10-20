import {
  CALL_OUTCOME_MAX_PATH,
  TRANSFER_LIMITS,
  type CallOutcomeRoute,
  type CallOutcomeSegment,
  type CallOutcomeSummary,
  type CallOutcomeTransfers,
  type RouteDecisionPayload,
  type RouteFallbackPayload,
  type RouteSegmentPayload,
  type SessionEvent,
} from '@winsendotai/ovo-contracts';
import { foldHuman } from './projection-human.ts';

/** One stored session event, as the outcome endpoint returns it. */
export interface StoredSessionEvent {
  callId: string;
  sequence: number;
  at: string;
  type: SessionEvent['type'];
  payload: Record<string, unknown>;
}

/** Captured variables are merged per key; past this many keys, new ones are dropped. */
export const CALL_OUTCOME_MAX_VARIABLES = 100;

export function noTransfers(): CallOutcomeTransfers {
  return { requested: 0, refused: 0, connected: 0, failed: 0 };
}

export function emptyCallOutcome(callId: string, at: string): CallOutcomeSummary {
  return {
    callId,
    outcome: null,
    endReason: null,
    disposition: null,
    dispositionSource: null,
    finalNode: null,
    statePath: [],
    variables: {},
    tiers: {},
    guardrail: { flagged: 0, blocked: 0 },
    route: null,
    segments: [],
    transfers: noTransfers(),
    human: null,
    events: 0,
    updatedAt: at,
  };
}

/**
 * Folds one event into the call's summary. Pure, so the Postgres and in-memory stores agree and the
 * summary can always be rebuilt from the events. The latest disposition wins: a call that first
 * promised to pay and was then transferred is reported as transferred.
 */
export function applySessionEvent(
  summary: CallOutcomeSummary,
  event: SessionEvent,
  at: string,
): CallOutcomeSummary {
  const next: CallOutcomeSummary = {
    ...summary,
    statePath: [...summary.statePath],
    variables: { ...summary.variables },
    tiers: { ...summary.tiers },
    guardrail: { ...summary.guardrail },
    route: summary.route && { ...summary.route, path: [...summary.route.path] },
    segments: summary.segments.map((segment) => ({ ...segment })),
    transfers: { ...summary.transfers },
    human: summary.human,
    events: summary.events + 1,
    updatedAt: at,
  };
  switch (event.type) {
    case 'turn.route': {
      const { tier, node } = event.payload;
      next.tiers[tier] = (next.tiers[tier] ?? 0) + 1;
      if (node && next.statePath.length === 0) enter(next, node);
      break;
    }
    case 'flow.state':
      enter(next, event.payload.to);
      break;
    case 'disposition':
      next.disposition = event.payload.disposition;
      next.dispositionSource = event.payload.source;
      if (event.payload.node) next.finalNode = event.payload.node;
      break;
    case 'variables.captured':
      for (const [key, value] of Object.entries(event.payload.variables)) {
        if (
          !Object.hasOwn(next.variables, key) &&
          Object.keys(next.variables).length >= CALL_OUTCOME_MAX_VARIABLES
        )
          continue;
        next.variables[key] = value;
      }
      break;
    case 'guardrail':
      next.guardrail[event.payload.action] += 1;
      break;
    case 'call.outcome':
      next.outcome = event.payload.outcome;
      next.endReason = event.payload.reason;
      if (event.payload.finalNode) next.finalNode = event.payload.finalNode;
      break;
    case 'route.decision':
      next.route = decided(next.route, event.payload);
      break;
    case 'route.fallback':
      next.route = fellBack(next.route, event.payload);
      break;
    case 'route.segment':
      next.route = segmented(next.route, event.payload);
      if (next.segments.length < TRANSFER_LIMITS.segmentsPerCall)
        next.segments.push(segmentOf(event.payload, at));
      break;
    case 'segment.ended': {
      const segment = next.segments.findLast((found) => found.index === event.payload.index);
      if (segment) {
        segment.durationMs = event.payload.durationMs;
        segment.ended = event.payload.ended;
      }
      break;
    }
    case 'transfer.requested':
      next.transfers.requested += 1;
      if (event.payload.result === 'refused') next.transfers.refused += 1;
      break;
    case 'transfer.completed':
      if (event.payload.outcome === 'connected') next.transfers.connected += 1;
      else if (event.payload.outcome !== 'caller_hangup') next.transfers.failed += 1;
      break;
    case 'human.requested':
    case 'human.state':
    case 'human.webhook':
    case 'human.completed':
      next.human = foldHuman(summary.human, event);
      break;
  }
  return next;
}

function segmentOf(segment: RouteSegmentPayload, at: string): CallOutcomeSegment {
  return {
    index: segment.index,
    role: segment.role,
    agentId: segment.agentId,
    releaseId: segment.releaseId,
    reason: segment.reason,
    poolId: segment.poolId ?? null,
    memberId: segment.memberId ?? null,
    language: segment.language ?? null,
    transfer: segment.transfer ?? null,
    startedAt: at,
    durationMs: null,
    ended: null,
  };
}

/**
 * Segment 0 (the router) is recorded before any decision, so a route can exist before its
 * decision: its ids are empty strings until `route.decision` arrives, which also tells a call
 * that hung up while routing apart from a routed one.
 */
function undecided(): CallOutcomeRoute {
  return {
    routingPointId: '',
    routingReleaseId: '',
    path: [],
    target: 'agent',
    agentId: null,
    releaseId: null,
    poolId: null,
    memberId: null,
    language: null,
    degraded: null,
    segments: 0,
  };
}

/**
 * R4: a taken or failed fallback step counts as a fallback (a `reask` that was taken counts as a
 * re-ask, a skipped step as neither). Counted before the decision too, and kept through it.
 */
function fellBack(
  route: CallOutcomeRoute | null,
  fallback: RouteFallbackPayload,
): CallOutcomeRoute {
  const base = route ?? undecided();
  if (fallback.step === 'reask')
    return fallback.result === 'taken' ? { ...base, reasks: (base.reasks ?? 0) + 1 } : base;
  return fallback.result === 'skipped' ? base : { ...base, fallbacks: (base.fallbacks ?? 0) + 1 };
}

/** The decision replaces the route and keeps the segment count and the fallback counts. */
function decided(route: CallOutcomeRoute | null, decision: RouteDecisionPayload): CallOutcomeRoute {
  return {
    routingPointId: decision.routingPointId,
    routingReleaseId: decision.routingReleaseId,
    path: [...decision.path],
    target: decision.target,
    agentId: decision.agentId ?? route?.agentId ?? null,
    releaseId: decision.releaseId ?? route?.releaseId ?? null,
    poolId: decision.poolId ?? route?.poolId ?? null,
    memberId: decision.memberId ?? route?.memberId ?? null,
    language: decision.language ?? null,
    degraded: decision.degraded ?? null,
    segments: route?.segments ?? 0,
    turns: decision.turns,
    routeMs: decision.routeMs,
    fallbacks: route?.fallbacks ?? 0,
    reasks: route?.reasks ?? 0,
  };
}

/**
 * Counts the segment. The agent that answered after routing (`route`, or `fallback` when the
 * chosen one failed to start) names the route's agent: after a failed start the summary names the
 * fallback agent that took the call, not the one that never answered (R1 audit 3). Transfers,
 * returns and re-routes never change the route; any other agent segment (`degraded`) names the
 * agent only if the decision has not.
 */
function segmented(route: CallOutcomeRoute | null, segment: RouteSegmentPayload): CallOutcomeRoute {
  const next = { ...(route ?? undecided()), segments: (route?.segments ?? 0) + 1 };
  if (segment.role !== 'agent') return next;
  if (segment.reason === 'route' || segment.reason === 'fallback') {
    // The decided agent's own segment keeps the decision's pool and member if it does not repeat them.
    const same = next.releaseId === segment.releaseId;
    next.agentId = segment.agentId;
    next.releaseId = segment.releaseId;
    next.poolId = segment.poolId ?? (same ? next.poolId : null);
    next.memberId = segment.memberId ?? (same ? next.memberId : null);
    if (segment.reason === 'fallback') next.degraded ??= 'target_start_failed';
    return next;
  }
  if (segment.reason === 'degraded' && next.releaseId === null) {
    next.agentId = segment.agentId;
    next.releaseId = segment.releaseId;
    next.poolId ??= segment.poolId ?? null;
    next.memberId ??= segment.memberId ?? null;
  }
  return next;
}

/** The state path skips a repeated state (a reprompt stays where it is) and keeps the newest. */
function enter(summary: CallOutcomeSummary, node: string): void {
  summary.finalNode = node;
  if (summary.statePath.at(-1) === node) return;
  summary.statePath.push(node);
  if (summary.statePath.length > CALL_OUTCOME_MAX_PATH)
    summary.statePath.splice(0, summary.statePath.length - CALL_OUTCOME_MAX_PATH);
}
