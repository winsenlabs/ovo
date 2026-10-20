import {
  type DecisionPort,
  type Inference,
  type RoutingHost,
  type RoutingReleaseSnapshot,
} from '@winsendotai/ovo-contracts';
import type { DisclosurePart } from '../disclosure.ts';
import { RouterCore } from '../core.ts';
import {
  createDecisionRunner,
  createExternalRunner,
  createLlmRunner,
  createRulesRunner,
} from '../engines/index.ts';
import {
  SIMULATION_LIMITS,
  type RoutingSimulationResult,
  type SimulationRequest,
  type SimulationTurnResult,
} from '../wire/index.ts';
import { createAnswerRunners } from './answers.ts';
import { createSimHandoff } from './handoff.ts';
import { createSimClock, createSimHost, memberKey } from './host.ts';
import { buildOutcome } from './outcome.ts';
import { poolObserver } from './pools.ts';
import { stepsOf } from './steps.ts';
import { warningsOf } from './warnings.ts';

/** The wall-clock guard: only a live engine can come near it. */
const GUARD_MS = 5_000;
const DEFAULT_IDLE_MS = 8_000;

export interface SimulateInput {
  snapshot: RoutingReleaseSnapshot;
  /** Already parsed (`SimulationRequest` without its `target`). */
  request: Omit<SimulationRequest, 'target'>;
  /** Epoch ms the run starts at when the request has no `call.at` (the server's now); `call.at` wins. */
  now: number;
  /** From the router release's agent config: the zone a callback is dated in, and its disclosure. */
  router: { timezone?: string; disclosure?: readonly DisclosurePart[] };
  /** After `assume`: whether `begin` and human queues exist. */
  flags: { transferEnabled: boolean; humanQueueEnabled: boolean };
  /** Active claims per `poolId:memberId` (`load: 'live'`). Absent: every member idle. */
  load?: Readonly<Record<string, number>>;
  /** Implementations for the engines the request marks `live`; the API refuses a request without them. */
  live?: {
    external?: RoutingHost['external'];
    decision?: DecisionPort;
    inference?: Inference;
  };
  /** The id events carry as `routingReleaseId`; a draft has none. */
  routingReleaseId?: string;
  signal?: AbortSignal;
  /** Test seam: the wall-clock guard in ms. */
  guardMs?: number;
}

export type SimulationRun = Pick<
  RoutingSimulationResult,
  'at' | 'turns' | 'outcome' | 'pools' | 'warnings' | 'stats' | 'assumed' | 'engineModes'
>;

/** A request the simulator cannot honour as asked (a live engine nobody supplied). */
export class SimulationInputError extends Error {
  constructor(
    readonly code: 'live_engine_unavailable' | 'live_turns_exceeded',
    message: string,
  ) {
    super(message);
    this.name = 'SimulationInputError';
  }
}

/**
 * Runs a scripted caller through a routing snapshot, offline: the real `RouterCore` (node walking,
 * fallback chains, pool ranking, human precheck) over a simulated host and handoff port, the real
 * rules engine and scripted decision, LLM and external answers. Nothing is dialled, claimed or
 * written; the clock is virtual, so a fixed `now` and request give a byte-identical result.
 */
export async function simulateRoute(input: SimulateInput): Promise<SimulationRun> {
  const { snapshot, request, flags } = input;
  const modes = request.engines.mode;
  const live = liveRunners(input);
  const clock = createSimClock(request.call.at ? Date.parse(request.call.at) : input.now);
  const full = new Set(request.faults.fullMembers.map((f) => memberKey(f.poolId, f.memberId)));
  const load = input.load ?? {};
  const host = createSimHost({
    clock,
    load,
    full,
    ...(live.host ? { external: live.host } : {}),
    call: {
      callId: 'sim',
      workspaceId: 'sim',
      routingPointId: snapshot.routingPointId,
      routingReleaseId: input.routingReleaseId ?? 'draft',
      ...(request.call.from ? { from: request.call.from } : {}),
      ...(request.call.to ? { to: request.call.to } : {}),
      variables: request.call.variables,
    },
  });
  const answers = createAnswerRunners({
    clock,
    answers: request.engines.answers,
    rules: createRulesRunner(host),
    live: live.runners,
  });
  const handoff = createSimHandoff({ snapshot, host, faults: request.faults, ...flagsOf(flags) });
  const pools = poolObserver({
    snapshot,
    clock,
    load,
    full,
    transferEnabled: flags.transferEnabled,
  });
  const core = new RouterCore(snapshot, {
    host,
    handoff,
    runners: answers.runners,
    ...(input.router.timezone ? { timezone: input.router.timezone } : {}),
    ...(input.router.disclosure ? { disclosure: input.router.disclosure } : {}),
    onPool: pools.observe,
  });

  const guard = new AbortController();
  const timer = setTimeout(
    () => guard.abort(new Error('simulation guard')),
    input.guardMs ?? GUARD_MS,
  );
  const signal = input.signal ? AbortSignal.any([guard.signal, input.signal]) : guard.signal;
  const turns: SimulationTurnResult[] = [];
  let seen = 0;
  let epoch = 0;
  let line = '';
  let unused = 0;
  const record = (
    index: number,
    kind: SimulationTurnResult['input'],
    reply: { say: string; phase: SimulationTurnResult['phase'] },
  ) => {
    // The voice engine's receipts: the turn is bound to its playback epoch, then heard in full.
    core.disclosure?.bind(epoch);
    if (reply.say)
      core.disclosure?.played({
        id: `sim-${epoch}`,
        text: reply.say,
        epoch,
        state: 'completed',
        evidence: 'simulated',
      });
    const events = core.recorder.events.slice(seen);
    seen += events.length;
    line = reply.say || line;
    turns.push({
      index,
      input: kind,
      say: reply.say,
      phase: reply.phase,
      virtualMs: clock.now() - clock.start,
      steps: events.flatMap((event) => stepsOf(event, modes)),
    });
  };
  let aborted = false;
  try {
    record(0, { kind: 'opening' }, await core.opening(signal));
    for (const [index, turn] of request.turns.entries()) {
      if (core.phase !== 'routing') {
        unused = request.turns.length - index;
        break;
      }
      clock.advance(
        turn.kind === 'silence'
          ? (snapshot.idle?.timeoutMs ?? DEFAULT_IDLE_MS)
          : SIMULATION_LIMITS.virtualTurnMs,
      );
      epoch += 1;
      const reply =
        turn.kind === 'speech'
          ? await core.turn({ text: turn.text }, signal)
          : turn.kind === 'dtmf'
            ? await core.turn({ digits: turn.digits }, signal)
            : await core.idle(signal);
      record(index + 1, turn, reply);
    }
  } catch (error) {
    if (!signal.aborted) throw error;
    aborted = true;
  } finally {
    clearTimeout(timer);
  }
  await core.abandon();

  return {
    at: new Date(clock.start).toISOString(),
    assumed: { ...flags },
    engineModes: {
      rules: 'real',
      decision: modes.decision,
      llm: modes.llm,
      external: modes.external,
    },
    turns,
    pools: pools.considered,
    outcome: buildOutcome({
      core,
      snapshot,
      records: handoff.records,
      line,
      elapsedMs: clock.now() - clock.start,
    }),
    warnings: warningsOf({
      snapshot,
      request,
      unscripted: answers.warnings,
      unusedTurns: unused,
      aborted,
      liveCalls: answers.live.calls,
    }),
    stats: {
      ms: answers.live.ms,
      virtualMs: clock.now() - clock.start,
      routerTurns: core.progress.turns,
      liveCalls: answers.live.calls,
    },
  };
}

const flagsOf = (flags: SimulateInput['flags']) => ({
  transferEnabled: flags.transferEnabled,
  humanQueueEnabled: flags.humanQueueEnabled,
});

/** The engines a request marks live, wrapped as runners; refuses a live engine with no implementation. */
function liveRunners(input: SimulateInput) {
  const { mode } = input.request.engines;
  const supplied = input.live ?? {};
  const missing = [
    mode.decision === 'live' && !supplied.decision && 'decision',
    mode.llm === 'live' && !supplied.inference && 'llm',
    mode.external === 'live' && !supplied.external && 'external',
  ].filter(Boolean);
  if (missing.length)
    throw new SimulationInputError(
      'live_engine_unavailable',
      `Live ${missing.join(' and ')} engine requested, but none was supplied`,
    );
  const any = [mode.decision, mode.llm, mode.external].includes('live');
  if (any && input.request.turns.length > SIMULATION_LIMITS.liveTurns)
    throw new SimulationInputError(
      'live_turns_exceeded',
      `A live engine allows at most ${SIMULATION_LIMITS.liveTurns} caller turns`,
    );
  const external = mode.external === 'live' ? supplied.external : undefined;
  return {
    host: external,
    runners: {
      ...(mode.decision === 'live' ? { decision: createDecisionRunner(supplied.decision) } : {}),
      ...(mode.llm === 'live' ? { llm: createLlmRunner(supplied.inference) } : {}),
      ...(external ? { external: createExternalRunner({ external }) } : {}),
    },
  };
}
