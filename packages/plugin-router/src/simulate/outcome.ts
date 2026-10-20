import type { RouteDecisionPayload, RoutingReleaseSnapshot } from '@winsendotai/ovo-contracts';
import type { RouterCore } from '../core.ts';
import type { RouteOutcome } from '../targets.ts';
import type { SimulationOutcome } from '../wire/index.ts';
import type { HandoffRecord } from './handoff.ts';

/** How the run ended, from the core's outcome and what it asked the handoff port. */
export function buildOutcome(input: {
  core: RouterCore;
  snapshot: RoutingReleaseSnapshot;
  records: readonly HandoffRecord[];
  line: string;
  elapsedMs: number;
}): SimulationOutcome {
  const { core, snapshot } = input;
  const decided = core.outcome;
  const progress = core.progress;
  const decision = core.recorder.events.find((event) => event.type === 'route.decision')
    ?.payload as RouteDecisionPayload | undefined;
  const base = {
    completionReason: core.completionReason() ?? null,
    node: decided?.node ?? progress.node,
    path: decided ? [...decided.path] : progress.path,
    language: progress.context.language ?? null,
    context: progress.context.values,
    turns: progress.turns,
    routeMs: decision?.routeMs ?? input.elapsedMs,
    line: input.line,
    degraded: null as string | null,
    agent: null,
    targetVariables: {},
    human: null,
    callback: null,
    endDisposition: null,
  };
  if (!decided) return { ...base, status: 'undecided' };
  return { ...base, ...resolved(decided, snapshot, input.records) };
}

function resolved(
  decided: RouteOutcome,
  snapshot: RoutingReleaseSnapshot,
  records: readonly HandoffRecord[],
): Partial<SimulationOutcome> & Pick<SimulationOutcome, 'status'> {
  const variables = (handoffId: string) =>
    records.find((record) => record.handoffId === handoffId)?.request.variables ?? {};
  switch (decided.kind) {
    case 'agent':
      return {
        status: 'agent',
        agent: {
          agentId: decided.agentId,
          releaseId: decided.releaseId,
          ...(decided.poolId ? { poolId: decided.poolId } : {}),
          ...(decided.memberId ? { memberId: decided.memberId } : {}),
        },
        targetVariables: variables(decided.handoffId),
        degraded: decided.degraded ?? null,
      };
    case 'queue':
      return { status: 'queue', targetVariables: variables(decided.handoffId) };
    case 'human': {
      const queue = Object.values(snapshot.queues).find((found) => found.key === decided.queueId);
      return {
        status: 'human',
        targetVariables: variables(decided.handoffId),
        human: {
          queueKey: decided.queueId,
          queueId: queue?.id ?? '',
          kind: queue?.definition.kind ?? 'managed',
          precheck: 'ok',
        },
      };
    }
    case 'end':
      return {
        status: 'end',
        degraded: decided.degraded ?? null,
        endDisposition: decided.disposition ?? null,
      };
    case 'callback':
      return {
        status: 'callback',
        callback: { inMinutes: decided.inMinutes, releaseId: decided.releaseId },
      };
  }
}
