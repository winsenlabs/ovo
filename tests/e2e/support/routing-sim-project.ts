import type { RoutingSimulationResult } from '../../../packages/plugin-router/src/index.ts';
import type { RouteEvent } from './routing-sim-stack.ts';

const pick = (payload: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(
    keys.filter((key) => payload[key] !== undefined).map((key) => [key, payload[key]]),
  );

/**
 * What a routed call and a simulation must agree on: each engine verdict and fallback step in
 * order, and where the route ended. Timings (`ms`, `routeMs`) and the model id are real-world
 * detail a simulation does not have; everything else a router decides is compared.
 */
export function project(events: readonly RouteEvent[]) {
  const keys: Record<string, string[]> = {
    'route.node': ['turn', 'node', 'engine', 'outcome', 'branch', 'confidence', 'reason'],
    'route.fallback': ['turn', 'node', 'step', 'result', 'attempt', 'reason'],
    'route.decision': [
      'path',
      'target',
      'agentId',
      'releaseId',
      'poolId',
      'memberId',
      'language',
      'context',
      'turns',
      'degraded',
    ],
  };
  return events
    .filter((event) => event.type in keys)
    .map((event) => ({ type: event.type, ...pick(event.payload, keys[event.type]!) }));
}

/** A simulation's steps as the events a call would have recorded. */
export function stepsAsEvents(result: Pick<RoutingSimulationResult, 'turns'>): RouteEvent[] {
  return result.turns.flatMap((turn) =>
    turn.steps.map((step) => ({
      type: step.type,
      payload: step.payload as Record<string, unknown>,
    })),
  );
}
