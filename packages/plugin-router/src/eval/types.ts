import type { RoutingEvalCase, RoutingScorecard } from '../wire/index.ts';

/*
 * Names the scorer needs that the scorecard type only spells inline, derived from it so they follow
 * the contract: the engines it counts, one engine's counts, and the fallback steps it reports.
 */
export type EngineName = keyof RoutingScorecard['perEngine'];
export type EngineCounts = RoutingScorecard['perEngine'][EngineName];
export type FallbackStepName = keyof RoutingScorecard['fallbackRate']['byStep'];
export type RoutingEvalExpect = RoutingEvalCase['expect'];

/**
 * The fallback steps a route can end on, shallowest first. `limit` is the router giving up on a slow
 * or long route, so it outranks the release default that always follows it.
 */
export const FALLBACK_STEPS: readonly FallbackStepName[] = [
  'default',
  'human',
  'callback',
  'end',
  'release_default',
  'limit',
];
