/**
 * The route simulator's wire shapes (Wave 18 design 3.1 and 3.2): the request the console builds
 * from its form and the result it renders. Written to the design until the contracts step lands
 * `SimulationRequest` and `RoutingSimulationResult`; the field names are the design's.
 */
import type { RoutingPointDraft } from './routing';

export const SIMULATION_SCHEMA = 'ovo.route-simulation/1';
export const SIMULATION_LIMITS = Object.freeze({
  turns: 20,
  textChars: 500,
  variables: 20,
  answers: 100,
  faults: 100,
  liveTurns: 8,
});

export type SimulationTurn =
  | { kind: 'speech'; text: string }
  | { kind: 'dtmf'; digits: string }
  | { kind: 'silence' };

export type SimulatedEngine = 'decision' | 'llm' | 'external';
export type SimulatedOutcome =
  | 'matched'
  | 'no_match'
  | 'low_confidence'
  | 'timeout'
  | 'error'
  | 'disabled';
export interface SimulatedAnswer {
  node: string;
  engine: SimulatedEngine;
  outcome?: SimulatedOutcome;
  branch?: string | null;
  confidence?: number;
  language?: string;
  slots?: Record<string, string>;
  clarify?: string;
  reason?: string;
  repeat: boolean;
}

export type EngineMode = 'mock' | 'live';
export type QueueFault = 'queue_closed' | 'queue_unavailable' | 'no_operators' | 'queue_full';
export interface SimulationFaults {
  fullMembers: { poolId: string; memberId: string }[];
  failedReleases: { releaseId: string; reason: 'compose_failed' | 'timeout' }[];
  queues: Record<string, QueueFault>;
}

export interface SimulationRequest {
  target:
    | { kind: 'release'; routingReleaseId: string }
    | { kind: 'draft'; pointId: string; draft?: RoutingPointDraft };
  call: { from?: string; to?: string; variables: Record<string, string>; at?: string };
  turns: SimulationTurn[];
  engines: {
    mode: Record<SimulatedEngine, EngineMode>;
    answers: SimulatedAnswer[];
  };
  faults: SimulationFaults;
  load: 'empty' | 'live';
  assume: { transferEnabled?: boolean; humanQueueEnabled?: boolean };
}

export type SimulationStep =
  | { type: 'route.node'; payload: Record<string, unknown>; mocked: boolean }
  | { type: 'route.fallback'; payload: Record<string, unknown> }
  | { type: 'route.decision'; payload: Record<string, unknown> }
  | { type: 'disposition'; payload: Record<string, unknown> }
  | { type: 'disclosure'; payload: { kinds: string[] } };

export interface SimulationTurnResult {
  index: number;
  input: { kind: 'opening' } | SimulationTurn;
  say: string;
  phase: 'routing' | 'announcing' | 'ended';
  virtualMs: number;
  steps: SimulationStep[];
}

export type PoolReason = 'disabled' | 'closed' | 'product' | 'skill' | 'language' | 'full' | 'fault';
export interface PoolConsideration {
  poolId: string;
  poolName: string;
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
    tier: number | null;
    active: number;
    capacity: number | null;
    full: boolean;
    picked: boolean;
    reasons: PoolReason[];
  }[];
  result: 'picked' | 'queued' | 'no_eligible_member' | 'pool_full';
}

export interface SimulationOutcome {
  status: 'agent' | 'queue' | 'human' | 'end' | 'callback' | 'undecided';
  completionReason: string | null;
  node: string | null;
  path: string[];
  language: string | null;
  context: Record<string, string>;
  turns: number;
  routeMs: number;
  line: string;
  degraded: string | null;
  agent: { agentId: string; releaseId: string; poolId?: string; memberId?: string } | null;
  targetVariables: Record<string, string>;
  human: { queueKey: string; queueId: string; kind: 'external' | 'managed'; precheck: string } | null;
  callback: { inMinutes: number; releaseId: string } | null;
  endDisposition: string | null;
}

export interface SimulationWarning {
  code: string;
  node?: string;
  engine?: string;
  message: string;
}

export interface RoutingSimulationResult {
  schema: typeof SIMULATION_SCHEMA;
  at: string;
  source: {
    kind: 'release' | 'draft';
    pointId: string;
    routingReleaseId: string | null;
    version: number | null;
    digest: string;
  };
  engineModes: { rules: 'real'; decision: EngineMode; llm: EngineMode; external: EngineMode };
  assumed: { transferEnabled: boolean; humanQueueEnabled: boolean };
  turns: SimulationTurnResult[];
  outcome: SimulationOutcome;
  pools: PoolConsideration[];
  warnings: SimulationWarning[];
  stats: { ms: number; virtualMs: number; routerTurns: number; liveCalls: number };
}

/** `POST /v1/routing/pools/explain` body (design 6). */
export interface PoolExplainRequest {
  poolId: string;
  target: {
    kind: 'pool';
    poolId: string;
    language: 'caller' | 'any';
    products?: { values: string[] };
    skills: string[];
  };
  context: { language?: string; product?: string };
  at?: string;
  load: 'empty' | 'live';
}
export type PoolExplanation = Omit<PoolConsideration, 'turn' | 'node'>;

/** A routing eval case (design 3.3), as the simulator's "Save as eval case" writes it. */
export interface RoutingEvalCaseJson {
  id: string;
  description?: string;
  tags: string[];
  call: SimulationRequest['call'];
  turns: SimulationTurn[];
  answers: SimulatedAnswer[];
  faults: SimulationFaults;
  expect: {
    status?: 'agent' | 'queue' | 'human' | 'end' | 'callback';
    path?: string[];
    node?: string;
    pool?: string;
    member?: string;
    agentId?: string;
    language?: string;
    fallback?: 'none' | 'default' | 'human' | 'callback' | 'end' | 'limit' | 'release_default';
    clarify?: boolean;
  };
}
