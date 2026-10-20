import { z } from 'zod';

/**
 * Wave 15 (R1) routing: a number pins a routing release; its router greets the caller, works out
 * language and intent through a tree of decision nodes, and hands the call to an agent release
 * picked from a pool. These are the shared grammars every routing schema uses.
 */

/** Node ids, branch keys, member ids, product and skill tags: the decision-question id grammar. */
export const RoutingKey = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/);
/** A route context key; becomes the call variable `ovo_route_<key>` for the target agent. */
export const RouteContextKey = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
/** Base language code, as `AgentLanguages.allowed` (ISO 639-1, or 639-3 without a 2-letter code). */
export const RouteLanguage = z.string().regex(/^[a-z]{2,3}$/);
/** Keypad digits a caller presses, as a rule matcher or a simulated turn: 1-8 of 0-9, * and #. */
export const DtmfDigits = z.string().regex(/^[0-9*#]{1,8}$/);
export const RouteUuid = z.string().uuid();
export const RouteAgentId = z.string().min(1).max(200);
export const RouteVariableName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const Line = z.string().trim().min(1).max(500);
/** Lines per language: `{ en: '...', hi: '...' }`. The router speaks the caller's language's line, else the default language's. */
export const RouteLines = z
  .record(RouteLanguage, Line)
  .refine(
    (lines) => Object.keys(lines).length >= 1 && Object.keys(lines).length <= 12,
    '1-12 languages',
  );
export type RouteLines = z.infer<typeof RouteLines>;

/** An agent release reference in a draft; a release snapshot holds only `pinned`. */
export const RouteReleaseRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pinned'), releaseId: RouteUuid }).strict(),
  z.object({ kind: z.literal('latest') }).strict(),
]);
export type RouteReleaseRef = z.infer<typeof RouteReleaseRef>;
export const RouteAgentRef = z.object({ agentId: RouteAgentId, release: RouteReleaseRef }).strict();
export type RouteAgentRef = z.infer<typeof RouteAgentRef>;

export const ROUTE_VARIABLE_PREFIX = 'ovo_route_';
/** The one tool the LLM classifier is offered. Reserved. */
export const ROUTE_TOOL_ID = 'ovo_route';
/** A router completion reason starts with this (`route:agent:intent>sales`, `route:end:intent`). */
export const ROUTE_REASON_PREFIX = 'route:';
/** Wire version of the external decision webhook. */
export const ROUTE_DECISION_SCHEMA = 'ovo.route-decision/1';
export const ROUTING_LIMITS = Object.freeze({
  nodes: 100,
  depth: 8,
  branchesPerNode: 32,
  enginesPerNode: 4,
  fallbackSteps: 6,
  poolMembers: 100,
  poolsPerRelease: 50,
  languages: 12,
});
