import {
  ROUTE_REASON_PREFIX,
  type RouteContext,
  type RouteDecisionPayload,
  type RoutingHost,
  type RoutingReleaseSnapshot,
} from '@winsendotai/ovo-contracts';
import type { RouteRecorder } from './events.ts';
import { BUILT_IN_LINES, pickLine } from './lines.ts';
import type { Resolution, RouteOutcome as Outcome } from './targets.ts';

const CONTEXT_KEYS = 16;
const COMPLETION_MAX = 200;

/** `route:<agent|end|callback>:<path joined by '>'>`, at most 200 characters. */
export function completionReasonOf(outcome: Outcome): string {
  return `${ROUTE_REASON_PREFIX}${outcome.kind}:${outcome.path.join('>')}`.slice(0, COMPLETION_MAX);
}

/** The `route.decision` event (§4.9): ids, keys and timings only, never the caller's words. */
export function decisionPayload(input: {
  call: RoutingHost['call'];
  outcome: Outcome;
  context: RouteContext;
  turns: number;
  routeMs: number;
}): RouteDecisionPayload {
  const { outcome, context } = input;
  const values = Object.entries(context.values).slice(0, CONTEXT_KEYS);
  const agent =
    outcome.kind === 'end' ? undefined : { agentId: outcome.agentId, releaseId: outcome.releaseId };
  const member =
    outcome.kind === 'agent' && outcome.poolId && outcome.memberId
      ? { poolId: outcome.poolId, memberId: outcome.memberId }
      : undefined;
  const degraded = outcome.kind === 'callback' ? undefined : outcome.degraded;
  return {
    routingPointId: input.call.routingPointId,
    routingReleaseId: input.call.routingReleaseId,
    path: outcome.path.slice(-32),
    target: outcome.kind,
    ...agent,
    ...member,
    ...(context.language ? { language: context.language } : {}),
    ...(values.length ? { context: Object.fromEntries(values) } : {}),
    turns: input.turns,
    routeMs: input.routeMs,
    ...(degraded ? { degraded } : {}),
  };
}

/**
 * Records how the route finished: the `route.decision`, and a `disposition` for an end that names
 * one or for a callback. A callback's carries the promise (`source: 'route'`, due `inMinutes` from
 * now, and the release to dial back: the callback step's agent or the release default), which the
 * API keeps durable (§5.5).
 */
export function recordFinish(
  recorder: RouteRecorder,
  input: {
    call: RoutingHost['call'];
    outcome: Outcome;
    context: RouteContext;
    turns: number;
    startedAt: number;
    now: number;
    timezone: string;
  },
): void {
  const { outcome, turns: turn } = input;
  recorder.decision(
    decisionPayload({ ...input, routeMs: Math.max(0, input.now - input.startedAt) }),
  );
  if (outcome.kind === 'end' && outcome.disposition)
    recorder.disposition({
      disposition: outcome.disposition,
      turn,
      node: outcome.node,
      reason: 'route_end',
    });
  if (outcome.kind === 'callback')
    recorder.disposition({
      disposition: 'callback',
      turn,
      node: outcome.node,
      reason: 'callback',
      callback: {
        dueAt: new Date(input.now + outcome.inMinutes * 60_000).toISOString(),
        timezone: input.timezone,
        source: 'route',
        node: outcome.node,
        releaseId: outcome.releaseId,
      },
    });
}

/** What the router says as it finishes: the connecting line before a handoff, else the end line. */
export function finishLine(
  resolution: Resolution,
  snapshot: RoutingReleaseSnapshot,
  language: string | undefined,
): string {
  if (resolution.kind !== 'agent') return resolution.line;
  const lines = snapshot.connecting ?? BUILT_IN_LINES.connecting;
  return pickLine(lines, language, snapshot.language.default);
}
