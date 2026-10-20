import type {
  DisclosureKind,
  HandoffBeginFailure,
  RouteDecisionPayload,
  RouteFallbackPayload,
  RouteNodePayload,
} from '@winsendotai/ovo-contracts';
import { SIMULATION_SCHEMA, type SimulationTurn } from './simulate.ts';

/** The simulation result (R4 design 3.2); `wire/index.ts` switches these to the contracts. */
export type SimulationStep =
  | { type: 'route.node'; payload: RouteNodePayload; mocked: boolean }
  | { type: 'route.fallback'; payload: RouteFallbackPayload }
  | { type: 'route.decision'; payload: RouteDecisionPayload }
  | { type: 'disposition'; payload: Record<string, unknown> }
  | { type: 'disclosure'; payload: { kinds: DisclosureKind[] } };

export interface SimulationTurnResult {
  /** 0 = the opening. */
  index: number;
  input: { kind: 'opening' } | SimulationTurn;
  /** What the router said this turn. */
  say: string;
  phase: 'routing' | 'announcing' | 'ended';
  /** Simulated clock since the first turn. */
  virtualMs: number;
  /** The route.* events of this turn, in order. */
  steps: SimulationStep[];
}

export interface PoolConsideration {
  poolId: string;
  poolName: string;
  /** Null for /pools/explain. */
  turn: number | null;
  node: string | null;
  wanted: {
    language: string | null;
    languageMode: 'caller' | 'any';
    products: string[] | null;
    skills: string[];
  };
  languageUsed: string | null;
  members: {
    memberId: string;
    agentId: string;
    releaseId: string;
    priority: number;
    enabled: boolean;
    open: boolean | null;
    productOk: boolean;
    skillsOk: boolean;
    languageOk: boolean;
    eligible: boolean;
    /** 0 = the highest priority tier. */
    tier: number | null;
    active: number;
    capacity: number | null;
    full: boolean;
    picked: boolean;
    reasons: ('disabled' | 'closed' | 'product' | 'skill' | 'language' | 'full' | 'fault')[];
  }[];
  result: 'picked' | 'queued' | 'no_eligible_member' | 'pool_full';
}

export interface SimulationOutcome {
  /** `undecided`: the turns ran out while still routing. */
  status: 'agent' | 'queue' | 'human' | 'end' | 'callback' | 'undecided';
  /** `route:agent:intent>sales`. */
  completionReason: string | null;
  node: string | null;
  path: string[];
  language: string | null;
  context: Record<string, string>;
  turns: number;
  /** Virtual. */
  routeMs: number;
  line: string;
  degraded: string | null;
  agent: { agentId: string; releaseId: string; poolId?: string; memberId?: string } | null;
  /** The ovo_route_* variables the target agent would receive. */
  targetVariables: Record<string, string>;
  human: {
    queueKey: string;
    queueId: string;
    kind: 'external' | 'managed';
    precheck: 'ok' | HandoffBeginFailure;
  } | null;
  callback: { inMinutes: number; releaseId: string } | null;
  endDisposition: string | null;
}

export type SimulationWarningCode =
  | 'engine_unscripted'
  | 'assumption_differs'
  | 'live_engine_used'
  | 'turns_unused'
  | 'clock_overridden'
  | 'draft_unpublished'
  | 'transfer_not_simulated'
  | 'load_unavailable'
  /** The wall-clock guard stopped the run; the result is what the router had done by then. */
  | 'simulation_aborted';
export interface SimulationWarning {
  code: SimulationWarningCode;
  node?: string;
  engine?: string;
  message: string;
}

export interface RoutingSimulationResult {
  schema: typeof SIMULATION_SCHEMA;
  /** ISO clock used. */
  at: string;
  source: {
    kind: 'release' | 'draft';
    pointId: string;
    routingReleaseId: string | null;
    version: number | null;
    digest: string;
  };
  engineModes: {
    rules: 'real';
    decision: 'mock' | 'live';
    llm: 'mock' | 'live';
    external: 'mock' | 'live';
  };
  assumed: { transferEnabled: boolean; humanQueueEnabled: boolean };
  turns: SimulationTurnResult[];
  outcome: SimulationOutcome;
  pools: PoolConsideration[];
  warnings: SimulationWarning[];
  stats: { ms: number; virtualMs: number; routerTurns: number; liveCalls: number };
}
