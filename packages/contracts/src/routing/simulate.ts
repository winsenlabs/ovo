import { z } from 'zod';
import {
  DtmfDigits,
  RouteContextKey,
  RouteLanguage,
  RouteUuid,
  RoutingKey,
  RouteVariableName,
} from './ids.ts';
import { RoutingPointDraft } from './point.ts';

/**
 * Wave 18 (R4) route simulation: a scripted caller (typed words, keypad digits, silence, a caller
 * id, a clock) driven through a routing release or an unpublished draft with no call placed. The
 * request is what the console and the eval harness send; the result is `simulate-result.ts`.
 */
export const SIMULATION_SCHEMA = 'ovo.route-simulation/1';
export const SIMULATION_LIMITS = Object.freeze({
  turns: 20,
  textChars: 500,
  variables: 20,
  answers: 100,
  faults: 100,
  bodyBytes: 64 * 1024,
  virtualTurnMs: 3_000,
  liveTurns: 8,
});
const E164 = z.string().regex(/^\+[1-9][0-9]{0,14}$/);

/** The opening (the greeting turn) is implicit and always runs first; `turns` are the caller's. */
export const SimulationTurn = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('speech'),
      text: z.string().trim().min(1).max(SIMULATION_LIMITS.textChars),
    })
    .strict(),
  z.object({ kind: z.literal('dtmf'), digits: DtmfDigits }).strict(),
  /** An idle turn (`RouterCore.idle`): the caller said nothing. */
  z.object({ kind: z.literal('silence') }).strict(),
]);
export type SimulationTurn = z.infer<typeof SimulationTurn>;

/** Engines a simulation can script; rules always run for real. */
export const SIMULATED_ENGINES = ['decision', 'llm', 'external'] as const;
export const SIMULATED_OUTCOMES = [
  'matched',
  'no_match',
  'low_confidence',
  'timeout',
  'error',
  'disabled',
] as const;
export const SimulatedAnswer = z
  .object({
    node: RoutingKey,
    engine: z.enum(SIMULATED_ENGINES),
    /** Absent with a branch: derived. matched at/above the engine's threshold, else low_confidence. */
    outcome: z.enum(SIMULATED_OUTCOMES).optional(),
    branch: RoutingKey.nullable().optional(),
    confidence: z.number().min(0).max(1).optional(),
    /** What a `detectLanguage` classifier reports. */
    language: RouteLanguage.optional(),
    slots: z.record(RouteContextKey, RoutingKey).optional(),
    clarify: z.string().trim().max(200).optional(),
    reason: z.string().max(80).optional(),
    /** Answers are consumed in order per (node, engine); `repeat` keeps this one for every later call. */
    repeat: z.boolean().default(false),
  })
  .strict();
export type SimulatedAnswer = z.infer<typeof SimulatedAnswer>;

export const SimulationCall = z
  .object({
    from: E164.optional(),
    to: E164.optional(),
    variables: z.record(RouteVariableName, z.string().max(200)).default({}),
    /** The clock the rules (`time`) and member hours read. Absent: now. Echoed in the result. */
    at: z.iso.datetime().optional(),
  })
  .strict()
  .refine((call) => Object.keys(call.variables).length <= SIMULATION_LIMITS.variables, {
    message: `At most ${SIMULATION_LIMITS.variables} variables`,
    path: ['variables'],
  })
  .default({ variables: {} });
export type SimulationCall = z.infer<typeof SimulationCall>;

export const SIMULATED_QUEUE_FAULTS = [
  'queue_closed',
  'queue_unavailable',
  'no_operators',
  'queue_full',
] as const;
export const SimulationFaults = z
  .object({
    /** Treated as at capacity for the run (a full pool path). */
    fullMembers: z
      .array(z.object({ poolId: RouteUuid, memberId: RoutingKey }).strict())
      .max(SIMULATION_LIMITS.faults)
      .default([]),
    /** Preparing this release fails (the node's chain moves on). */
    failedReleases: z
      .array(
        z
          .object({
            releaseId: RouteUuid,
            reason: z.enum(['compose_failed', 'timeout']).default('compose_failed'),
          })
          .strict(),
      )
      .max(SIMULATION_LIMITS.faults)
      .default([]),
    /** A bound queue key refuses at `begin`. */
    queues: z.record(RoutingKey, z.enum(SIMULATED_QUEUE_FAULTS)).default({}),
  })
  .strict()
  .default({ fullMembers: [], failedReleases: [], queues: {} });
export type SimulationFaults = z.infer<typeof SimulationFaults>;

export const SimulationAssume = z
  .object({ transferEnabled: z.boolean().optional(), humanQueueEnabled: z.boolean().optional() })
  .strict();
export type SimulationAssume = z.infer<typeof SimulationAssume>;

const EngineMode = z.enum(['mock', 'live']);
export const SimulationEngines = z
  .object({
    mode: z
      .object({
        decision: EngineMode.default('mock'),
        llm: EngineMode.default('mock'),
        external: EngineMode.default('mock'),
      })
      .strict()
      .default({ decision: 'mock', llm: 'mock', external: 'mock' }),
    answers: z.array(SimulatedAnswer).max(SIMULATION_LIMITS.answers).default([]),
  })
  .strict()
  .default({ mode: { decision: 'mock', llm: 'mock', external: 'mock' }, answers: [] });
export type SimulationEngines = z.infer<typeof SimulationEngines>;

export const SimulationTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('release'), routingReleaseId: RouteUuid }).strict(),
  /** Unpublished: the stored draft, or the given one (an unsaved editor state). Resolved like publish; blockers refuse. */
  z
    .object({ kind: z.literal('draft'), pointId: RouteUuid, draft: RoutingPointDraft.optional() })
    .strict(),
]);
export type SimulationTarget = z.infer<typeof SimulationTarget>;

export const SimulationRequest = z
  .object({
    target: SimulationTarget,
    call: SimulationCall,
    turns: z.array(SimulationTurn).max(SIMULATION_LIMITS.turns).default([]),
    engines: SimulationEngines,
    faults: SimulationFaults,
    /** `empty`: every member idle (deterministic, default). `live`: current active claims of the workspace. */
    load: z.enum(['empty', 'live']).default('empty'),
    /** What-if switches; absent: the server's flags. The result warns when an assumption differs from the server. */
    assume: SimulationAssume.default({}),
  })
  .strict();
export type SimulationRequest = z.infer<typeof SimulationRequest>;
