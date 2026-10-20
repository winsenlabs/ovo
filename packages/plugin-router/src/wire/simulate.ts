import { z } from 'zod';
import {
  RouteContextKey,
  RouteLanguage,
  RoutingKey,
  RoutingPointDraft,
  RouteUuid,
  RouteVariableName,
} from '@winsendotai/ovo-contracts';

/*
 * The simulation request, as the R4 design (section 3.1) specifies it. Wave 18's core lane lands
 * the same schemas in `@winsendotai/ovo-contracts` (routing/simulate.ts); until then this module
 * is the plugin's copy, and `wire/index.ts` is the one place that switches to the contracts.
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
  z.object({ kind: z.literal('speech'), text: z.string().trim().min(1).max(500) }).strict(),
  z.strictObject({ kind: z.literal('dtmf'), digits: z.string().regex(/^[0-9*#]{1,8}$/) }),
  z.object({ kind: z.literal('silence') }).strict(),
]);
export type SimulationTurn = z.infer<typeof SimulationTurn>;

export const SIMULATED_ENGINES = ['decision', 'llm', 'external'] as const;
export const SimulatedAnswer = z
  .object({
    node: RoutingKey,
    engine: z.enum(SIMULATED_ENGINES),
    /** Absent with a branch: derived. matched at/above the engine's threshold, else low_confidence. */
    outcome: z
      .enum(['matched', 'no_match', 'low_confidence', 'timeout', 'error', 'disabled'])
      .optional(),
    branch: RoutingKey.nullable().optional(),
    confidence: z.number().min(0).max(1).optional(),
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
  .default({ variables: {} });

export const SimulationFaults = z
  .object({
    /** Treated as at capacity for the run (a full pool path). */
    fullMembers: z
      .array(z.object({ poolId: RouteUuid, memberId: RoutingKey }).strict())
      .max(100)
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
      .max(100)
      .default([]),
    /** A bound queue key refuses at `begin`. */
    queues: z
      .record(
        RoutingKey,
        z.enum(['queue_closed', 'queue_unavailable', 'no_operators', 'queue_full']),
      )
      .default({}),
  })
  .strict()
  .default({ fullMembers: [], failedReleases: [], queues: {} });

const MODES = z.enum(['mock', 'live']);
export const SimulationRequest = z
  .object({
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('release'), routingReleaseId: RouteUuid }).strict(),
      z
        .object({
          kind: z.literal('draft'),
          pointId: RouteUuid,
          draft: RoutingPointDraft.optional(),
        })
        .strict(),
    ]),
    call: SimulationCall,
    turns: z.array(SimulationTurn).max(20).default([]),
    engines: z
      .object({
        mode: z
          .object({
            decision: MODES.default('mock'),
            llm: MODES.default('mock'),
            external: MODES.default('mock'),
          })
          .strict()
          .default({ decision: 'mock', llm: 'mock', external: 'mock' }),
        answers: z.array(SimulatedAnswer).max(100).default([]),
      })
      .strict()
      .default({ mode: { decision: 'mock', llm: 'mock', external: 'mock' }, answers: [] }),
    faults: SimulationFaults,
    /** `empty`: every member idle (deterministic, default). `live`: current active claims. */
    load: z.enum(['empty', 'live']).default('empty'),
    /** What-if switches; absent: the server's flags. */
    assume: z
      .object({
        transferEnabled: z.boolean().optional(),
        humanQueueEnabled: z.boolean().optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type SimulationRequest = z.infer<typeof SimulationRequest>;
