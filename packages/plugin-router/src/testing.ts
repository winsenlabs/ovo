import type {
  ExternalDecisionResponse,
  HandoffPrepareResult,
  MemberClaim,
  RoutingEngine,
  RoutingEngineKind,
  RoutingHost,
  RoutingMemberCandidate,
  SegmentHandoffPort,
  SegmentHandoffRequest,
} from '@winsendotai/ovo-contracts';
import type { EngineInput, EngineResult, EngineRunner, EngineRunners } from './engines/index.ts';

export { exampleRoutingSnapshot, EXAMPLE_IDS } from './testing-snapshot.ts';

type Tiers = readonly (readonly RoutingMemberCandidate[])[];
type ExternalInput = Parameters<RoutingHost['external']>[0];

/** A `RoutingHost` for tests: a settable clock, scripted claims and external answers, recorded calls. */
export interface FakeRoutingHost extends RoutingHost {
  /** Moves the fake clock on. */
  advance(ms: number): void;
  readonly claims: Tiers[];
  readonly externals: ExternalInput[];
}

export function fakeRoutingHost(
  options: {
    call?: Partial<RoutingHost['call']>;
    /** Epoch ms the clock starts at. */
    start?: number;
    /** Default: the first candidate of the first tier, claimed. */
    claim?: (tiers: Tiers) => MemberClaim | Promise<MemberClaim>;
    external?: (
      input: ExternalInput,
    ) => ExternalDecisionResponse | Promise<ExternalDecisionResponse>;
  } = {},
): FakeRoutingHost {
  let now = options.start ?? Date.UTC(2026, 9, 15, 6, 30);
  let claimed = 0;
  const claims: Tiers[] = [];
  const externals: ExternalInput[] = [];
  return {
    call: {
      callId: 'call-1',
      workspaceId: 'ws-1',
      routingPointId: '00000000-0000-4000-8000-0000000000a1',
      routingReleaseId: '00000000-0000-4000-8000-0000000000a2',
      variables: {},
      ...options.call,
    },
    claims,
    externals,
    advance: (ms) => void (now += ms),
    now: () => now,
    async claim(tiers) {
      claims.push(tiers);
      if (options.claim) return options.claim(tiers);
      const candidate = tiers[0]?.[0];
      if (!candidate) return { kind: 'full' };
      claimed += 1;
      const claimId = `00000000-0000-4000-8000-${String(claimed).padStart(12, '0')}`;
      return { kind: 'claimed', claimId, candidate };
    },
    async external(input) {
      externals.push(input);
      if (!options.external) return { branch: null, confidence: 1, slots: {} };
      return options.external(input);
    },
  };
}

/** A `SegmentHandoffPort` for tests: scripted prepare results; every call recorded. */
export interface FakeSegmentHandoffPort extends SegmentHandoffPort {
  readonly prepared: SegmentHandoffRequest[];
  readonly committed: string[];
  readonly abandoned: string[];
}

export function fakeSegmentHandoffPort(
  options: {
    prepare?: (
      request: SegmentHandoffRequest,
      signal: AbortSignal,
    ) => HandoffPrepareResult | Promise<HandoffPrepareResult>;
  } = {},
): FakeSegmentHandoffPort {
  const prepared: SegmentHandoffRequest[] = [];
  const committed: string[] = [];
  const abandoned: string[] = [];
  return {
    prepared,
    committed,
    abandoned,
    async prepare(request, signal) {
      prepared.push(request);
      if (options.prepare) return options.prepare(request, signal);
      return { ok: true, handoffId: `handoff-${prepared.length}` };
    },
    commit: (handoffId) => void committed.push(handoffId),
    async abandon(handoffId) {
      abandoned.push(handoffId);
    },
  };
}

/** Scripted engine answers, per node and engine kind, consumed in order. */
export type EngineScript = Record<string, Partial<Record<RoutingEngineKind, EngineResult[]>>>;

export interface ScriptedEngines {
  runners: EngineRunners;
  /** Every engine call, in order: the node, the kind and what it was given. */
  readonly calls: { node: string; kind: RoutingEngineKind; input: EngineInput }[];
}

/**
 * Engine runners that answer from `script` instead of running anything: the next scripted result
 * for the node and kind, else `no_match` with reason `unscripted`. `real` runners, when given, run
 * any kind the script does not mention at all (rules in a replay, say).
 */
export function scriptedEngines(
  script: EngineScript,
  real?: Partial<EngineRunners>,
): ScriptedEngines {
  const calls: ScriptedEngines['calls'] = [];
  const queues = new Map<string, EngineResult[]>();
  const runner =
    (kind: RoutingEngineKind) =>
    async (engine: RoutingEngine, input: EngineInput): Promise<EngineResult> => {
      calls.push({ node: input.node.id, kind, input });
      const scripted = script[input.node.id]?.[kind];
      const fallback = real?.[kind] as EngineRunner | undefined;
      if (!scripted && fallback) return fallback(engine as never, input);
      const key = `${input.node.id}:${kind}`;
      if (!queues.has(key)) queues.set(key, [...(scripted ?? [])]);
      return queues.get(key)!.shift() ?? { outcome: 'no_match', reason: 'unscripted' };
    };
  return {
    calls,
    runners: {
      rules: runner('rules'),
      decision: runner('decision'),
      llm: runner('llm'),
      external: runner('external'),
    },
  };
}
