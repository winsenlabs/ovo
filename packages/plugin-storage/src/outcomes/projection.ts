import {
  CALL_OUTCOME_MAX_PATH,
  type CallOutcomeRoute,
  type CallOutcomeSummary,
  type RouteDecisionPayload,
  type RouteSegmentPayload,
  type SessionEvent,
} from '@winsendotai/ovo-contracts';

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
    case 'route.segment':
      next.route = segmented(next.route, event.payload);
      break;
  }
  return next;
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

/** The decision replaces the route and keeps the segment count. */
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
  };
}

/** Counts the segment; an agent segment names the agent if the decision has not. */
function segmented(route: CallOutcomeRoute | null, segment: RouteSegmentPayload): CallOutcomeRoute {
  const next = { ...(route ?? undecided()), segments: (route?.segments ?? 0) + 1 };
  if (segment.role === 'agent' && next.releaseId === null) {
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
