import { z } from 'zod';
import { RouteLanguage } from './ids.ts';
import { RouteDecisionPayload, RouteFallbackPayload, RouteNodePayload } from './events.ts';
import { SIMULATION_SCHEMA, SimulationTurn } from './simulate.ts';
import { DisclosureKind } from './transfer.ts';
import type { HandoffBeginFailure } from './runtime.ts';

/**
 * What `POST /v1/routing/simulate` answers (design 3.2). Strings that name a node, branch, pool or
 * member are ids and keys; the only caller words in a result are the ones the caller of the
 * endpoint typed, echoed in `turns[].input`.
 */
const Text = z.string().max(1_000);
const Id = z.string().min(1).max(200);

export const SimulationStep = z.discriminatedUnion('type', [
  z.object({ type: z.literal('route.node'), payload: RouteNodePayload, mocked: z.boolean() }),
  z.object({ type: z.literal('route.fallback'), payload: RouteFallbackPayload }),
  z.object({ type: z.literal('route.decision'), payload: RouteDecisionPayload }),
  z.object({ type: z.literal('disposition'), payload: z.record(z.string(), z.unknown()) }),
  z.object({
    type: z.literal('disclosure'),
    payload: z.object({ kinds: z.array(DisclosureKind) }),
  }),
]);
export type SimulationStep = z.infer<typeof SimulationStep>;

export const SimulationTurnResult = z.object({
  /** 0 = the opening. */
  index: z.number().int().nonnegative(),
  input: z.union([z.object({ kind: z.literal('opening') }), SimulationTurn]),
  /** What the router said this turn. */
  say: Text,
  phase: z.enum(['routing', 'announcing', 'ended']),
  /** Simulated clock since the first turn. */
  virtualMs: z.number().nonnegative(),
  /** The route.* events of this turn, in order. */
  steps: z.array(SimulationStep),
});
export type SimulationTurnResult = z.infer<typeof SimulationTurnResult>;

export const POOL_REASONS = [
  'disabled',
  'closed',
  'product',
  'skill',
  'language',
  'full',
  'fault',
] as const;
export const PoolMemberConsideration = z.object({
  memberId: Id,
  agentId: Id,
  releaseId: Id,
  priority: z.number().int(),
  enabled: z.boolean(),
  /** Null when the member has no hours. */
  open: z.boolean().nullable(),
  productOk: z.boolean(),
  skillsOk: z.boolean(),
  languageOk: z.boolean(),
  eligible: z.boolean(),
  /** 0 = the highest priority tier; null while not eligible. */
  tier: z.number().int().nonnegative().nullable(),
  active: z.number().int().nonnegative(),
  capacity: z.number().int().positive().nullable(),
  full: z.boolean(),
  picked: z.boolean(),
  reasons: z.array(z.enum(POOL_REASONS)),
});
export type PoolMemberConsideration = z.infer<typeof PoolMemberConsideration>;

export const PoolConsideration = z.object({
  poolId: Id,
  poolName: z.string().max(200),
  /** Null for `/pools/explain`. */
  turn: z.number().int().nonnegative().nullable(),
  node: z.string().max(200).nullable(),
  wanted: z.object({
    language: RouteLanguage.nullable(),
    languageMode: z.enum(['caller', 'any']),
    products: z.array(z.string()).nullable(),
    skills: z.array(z.string()),
  }),
  /** The caller language, the default, or a `languageFallback` entry. */
  languageUsed: RouteLanguage.nullable(),
  members: z.array(PoolMemberConsideration),
  result: z.enum(['picked', 'queued', 'no_eligible_member', 'pool_full']),
});
export type PoolConsideration = z.infer<typeof PoolConsideration>;

/** The `HandoffBeginFailure` codes, for the `human.precheck` field. Kept exhaustive by the check below. */
export const HANDOFF_BEGIN_FAILURES = [
  'release_not_allowed',
  'release_missing',
  'compose_failed',
  'timeout',
  'call_ended',
  'busy',
  'unsupported',
  'queue_unknown',
  'queue_closed',
  'queue_unavailable',
  'queue_full',
  'no_operators',
  'webhook_rejected',
  'webhook_failed',
  'ticket_expired',
  'carrier_refused',
  'pool_full',
  'segments_exhausted',
  'time_exhausted',
] as const;
const _failuresExhaustive: HandoffBeginFailure extends (typeof HANDOFF_BEGIN_FAILURES)[number]
  ? true
  : never = true;
void _failuresExhaustive;

export const SIMULATION_STATUSES = [
  'agent',
  'queue',
  'human',
  'end',
  'callback',
  'undecided',
] as const;
export const SimulationOutcome = z.object({
  /** `undecided`: the caller's turns ran out while the router was still routing. */
  status: z.enum(SIMULATION_STATUSES),
  /** `route:agent:intent>sales`. */
  completionReason: z.string().max(400).nullable(),
  node: z.string().max(200).nullable(),
  path: z.array(z.string().max(200)).max(32),
  language: RouteLanguage.nullable(),
  context: z.record(z.string(), z.string()),
  turns: z.number().int().nonnegative(),
  /** Virtual. */
  routeMs: z.number().nonnegative(),
  /** The last line the router said. */
  line: Text,
  degraded: z.string().max(200).nullable(),
  agent: z
    .object({
      agentId: Id,
      releaseId: Id,
      poolId: Id.optional(),
      memberId: Id.optional(),
    })
    .nullable(),
  /** The `ovo_route_*` variables the target agent would receive. */
  targetVariables: z.record(z.string(), z.string()),
  human: z
    .object({
      queueKey: Id,
      queueId: Id,
      kind: z.enum(['external', 'managed']),
      precheck: z.union([z.literal('ok'), z.enum(HANDOFF_BEGIN_FAILURES)]),
    })
    .nullable(),
  callback: z.object({ inMinutes: z.number().int().positive(), releaseId: Id }).nullable(),
  endDisposition: z.string().max(200).nullable(),
});
export type SimulationOutcome = z.infer<typeof SimulationOutcome>;

export const SIMULATION_WARNING_CODES = [
  /** A mock engine had no answer for a node it was asked about (`node`, `engine`). */
  'engine_unscripted',
  /** `assume.*` differs from the server flag. */
  'assumption_differs',
  'live_engine_used',
  'turns_unused',
  'clock_overridden',
  'draft_unpublished',
  /** The release has a catalogue; in-call transfers are not run. */
  'transfer_not_simulated',
  /** `load: live` was asked and claim storage could not answer; ran as `empty`. */
  'load_unavailable',
] as const;
export const SimulationWarning = z.object({
  code: z.enum(SIMULATION_WARNING_CODES),
  node: z.string().max(200).optional(),
  engine: z.string().max(40).optional(),
  message: z.string().max(400),
});
export type SimulationWarning = z.infer<typeof SimulationWarning>;
export type SimulationWarningCode = (typeof SIMULATION_WARNING_CODES)[number];

const EngineModeResult = z.enum(['mock', 'live']);
export const RoutingSimulationResult = z.object({
  schema: z.literal(SIMULATION_SCHEMA),
  /** ISO clock used. */
  at: z.iso.datetime(),
  source: z.object({
    kind: z.enum(['release', 'draft']),
    pointId: Id,
    routingReleaseId: Id.nullable(),
    version: z.number().int().positive().nullable(),
    digest: z.string().max(64),
  }),
  engineModes: z.object({
    rules: z.literal('real'),
    decision: EngineModeResult,
    llm: EngineModeResult,
    external: EngineModeResult,
  }),
  assumed: z.object({ transferEnabled: z.boolean(), humanQueueEnabled: z.boolean() }),
  turns: z.array(SimulationTurnResult),
  outcome: SimulationOutcome,
  pools: z.array(PoolConsideration),
  warnings: z.array(SimulationWarning),
  stats: z.object({
    ms: z.number().nonnegative(),
    virtualMs: z.number().nonnegative(),
    routerTurns: z.number().int().nonnegative(),
    liveCalls: z.number().int().nonnegative(),
  }),
});
export type RoutingSimulationResult = z.infer<typeof RoutingSimulationResult>;
