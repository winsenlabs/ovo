import * as router from '@winsendotai/ovo-plugin-router';
import type {
  DecisionPort,
  DisclosureKind,
  Inference,
  PoolConsideration,
  PoolSnapshot,
  RouteContext,
  RoutingEvalCase,
  RoutingHost,
  RoutingPoolTarget,
  RoutingReleaseSnapshot,
  RoutingScorecard,
  RoutingSimulationResult,
  SimulationRequest,
} from '@winsendotai/ovo-contracts';

/**
 * The router functions the API drives (R4 design 5.1, 5.2, 5.6), behind one seam. They live in
 * `plugin-router`, which runs the same `RouterCore` a call does, so a simulation, a pool
 * explanation and an eval run cannot disagree with the worker. The routes take the seam rather than
 * the package, so they are tested with a scripted simulator and answer 503 where the installed
 * router is older than R4.
 */
export type SimulationRun = Pick<
  RoutingSimulationResult,
  'at' | 'turns' | 'outcome' | 'pools' | 'warnings' | 'stats' | 'assumed' | 'engineModes'
>;

/** Engines a request marks `live` run through these; absent, the API refuses before running. */
export interface LiveEngines {
  external?: RoutingHost['external'];
  decision?: DecisionPort;
  inference?: Inference;
}

/**
 * Real engines for a request that marks some `live` (admin only, off by default, provider cost).
 * `open` composes them from the router release and `dispose` releases that composition.
 */
export interface LiveEngineFactory {
  /** The decision and LLM engines can run live. */
  readonly llm: boolean;
  /** The external engine can run live. */
  readonly external: boolean;
  /** Throws `LiveEngineUnavailable` where the router release cannot back a requested engine. */
  open(request: LiveEngineRequest): Promise<{ ports: LiveEngines; dispose(): Promise<void> }>;
}

/** A live engine this installation cannot compose for this router release (409, never a mock). */
export class LiveEngineUnavailable extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'LiveEngineUnavailable';
  }
}

/** What a live run needs to compose its engines: the router release and the simulated call. */
export interface LiveEngineRequest {
  workspaceId: string;
  routerReleaseId: string;
  /** Which engines the request marks live. */
  modes: { decision: 'mock' | 'live'; llm: 'mock' | 'live'; external: 'mock' | 'live' };
  /** The simulated call, as the external engine's request describes it. */
  call: {
    routingPointId: string;
    routingReleaseId: string;
    from?: string;
    to?: string;
    variables: Record<string, string>;
  };
}

export interface RouterFlags {
  transferEnabled: boolean;
  humanQueueEnabled: boolean;
}

/** From the router release's agent config: the zone a callback is dated in, and its disclosure. */
export interface RouterInfo {
  timezone?: string;
  disclosure?: readonly { kind: DisclosureKind; text: string }[];
}

export interface SimulatorInput {
  snapshot: RoutingReleaseSnapshot;
  /** Already parsed: the request without its `target`. */
  request: Omit<SimulationRequest, 'target'>;
  /** Epoch ms the run starts at when the request has no `call.at`. */
  now: number;
  router: RouterInfo;
  /** After `assume`. */
  flags: RouterFlags;
  /** Active claims per `poolId:memberId` (`load: 'live'`). */
  load?: Readonly<Record<string, number>>;
  live?: LiveEngines;
  /** The id events carry as `routingReleaseId`; a draft has none. */
  routingReleaseId?: string;
  signal?: AbortSignal;
}

export interface ExplainInput {
  pool: PoolSnapshot;
  target: RoutingPoolTarget;
  context: RouteContext;
  defaultLanguage: string;
  now: number;
  load?: Readonly<Record<string, number>>;
  fullMembers?: ReadonlySet<string>;
  waitForCapacity?: boolean;
}

export interface ScorerInput {
  snapshot: RoutingReleaseSnapshot;
  cases: readonly RoutingEvalCase[];
  name: string;
  engineMode: RoutingScorecard['engineMode'];
  flags: RouterFlags;
  router: RouterInfo;
  routingReleaseId?: string | null;
  now?: number;
}

export interface RoutingSimulator {
  simulateRoute(input: SimulatorInput): Promise<SimulationRun>;
  explainPool(input: ExplainInput): Omit<PoolConsideration, 'turn' | 'node'>;
  scoreRoutingCorpus(input: ScorerInput): Promise<RoutingScorecard>;
  routingCorpusDigest(cases: readonly RoutingEvalCase[]): string;
}

/** A request the simulator cannot honour as asked (`live_engine_unavailable`, `live_turns_exceeded`). */
export function isSimulationInputError(
  error: unknown,
): error is Error & { code: 'live_engine_unavailable' | 'live_turns_exceeded' } {
  return error instanceof Error && error.name === 'SimulationInputError';
}

/**
 * The installed router's simulator, or undefined when it predates R4. `module` is the router
 * package unless a test swaps it.
 */
export function routerSimulator(module: object = router): RoutingSimulator | undefined {
  const found = module as Partial<RoutingSimulator>;
  if (!found.simulateRoute || !found.explainPool || !found.scoreRoutingCorpus) return undefined;
  if (!found.routingCorpusDigest) return undefined;
  return {
    simulateRoute: found.simulateRoute,
    explainPool: found.explainPool,
    scoreRoutingCorpus: found.scoreRoutingCorpus,
    routingCorpusDigest: found.routingCorpusDigest,
  };
}
