import {
  effectiveHold,
  queueByKey,
  type HandoffBeginFailure,
  type HandoffBeginResult,
  type HandoffPrepareFailure,
  type HandoffPrepareResult,
  type RoutingHost,
  type RoutingReleaseSnapshot,
  type SegmentHandoffPort,
  type SegmentHandoffRequest,
} from '@winsendotai/ovo-contracts';
import { isOpen } from '../hours.ts';
import type { SimulationRequest } from '../wire/index.ts';

export interface SimHandoffInput {
  snapshot: RoutingReleaseSnapshot;
  host: Pick<RoutingHost, 'claim' | 'now'>;
  faults: SimulationRequest['faults'];
  /** Whether the host offers `begin` (OVO_ROUTING_TRANSFER_ENABLED, as assumed). */
  transferEnabled: boolean;
  humanQueueEnabled: boolean;
}

/** What the router asked the port, in order: the simulator reads the target's variables from it. */
export interface HandoffRecord {
  handoffId: string;
  request: SegmentHandoffRequest;
  result: 'ok' | HandoffBeginFailure;
}

export interface SimHandoff extends SegmentHandoffPort {
  readonly records: HandoffRecord[];
}

type Failure = Exclude<HandoffBeginResult, { ok: true }>['reason'];

/**
 * A `SegmentHandoffPort` that composes nothing. A handoff is accepted unless a fault says
 * otherwise; refusals use the real codes (`compose_failed`, `queue_closed`, `pool_full` ...) so the
 * node's fallback chain moves on as it would. `begin` exists only when transfers are assumed on,
 * exactly as the worker offers it, which is what makes a queued pool, a human queue and the
 * router's disclosure reachable.
 */
export function createSimHandoff(input: SimHandoffInput): SimHandoff {
  const records: HandoffRecord[] = [];
  const failed = new Map(
    input.faults.failedReleases.map((fault) => [fault.releaseId, fault.reason]),
  );
  const accept = (request: SegmentHandoffRequest, result: 'ok' | Failure) => {
    const handoffId = `sim-handoff-${records.length + 1}`;
    records.push({ handoffId, request, result });
    return handoffId;
  };
  const refuse = (request: SegmentHandoffRequest, reason: Failure) => {
    accept(request, reason);
    return { ok: false as const, reason };
  };

  async function prepare(request: SegmentHandoffRequest): Promise<HandoffPrepareResult> {
    if (request.kind !== 'agent') return refuse(request, 'unsupported') as HandoffPrepareResult;
    const reason = failed.get(request.releaseId);
    if (reason) return refuse(request, reason) as HandoffPrepareResult;
    return { ok: true, handoffId: accept(request, 'ok') };
  }

  async function begin(request: SegmentHandoffRequest): Promise<HandoffBeginResult> {
    switch (request.kind) {
      case 'agent': {
        const reason = failed.get(request.releaseId);
        if (reason) return refuse(request, reason);
        return { ok: true, handoffId: accept(request, 'ok'), state: 'preparing' };
      }
      case 'queue': {
        const claim = await input.host.claim(request.tiers, new AbortController().signal);
        if (claim.kind !== 'full')
          return { ok: true, handoffId: accept(request, 'ok'), state: 'preparing' };
        if (!effectiveHold(input.snapshot.transfer).waitForCapacity)
          return refuse(request, 'pool_full');
        return { ok: true, handoffId: accept(request, 'ok'), state: 'queued' };
      }
      case 'human': {
        const refusal = humanRefusal(input, request.queueId);
        return refusal
          ? refuse(request, refusal)
          : { ok: true, handoffId: accept(request, 'ok'), state: 'preparing' };
      }
      case 'node':
        return refuse(request, 'unsupported');
    }
  }

  return {
    records,
    prepare: (request) => prepare(request),
    ...(input.transferEnabled ? { begin: (request: SegmentHandoffRequest) => begin(request) } : {}),
    commit: () => undefined,
    abandon: async () => undefined,
  };
}

/** The human queue gates the worker's precheck applies that a simulation can know (design 7.2). */
function humanRefusal(input: SimHandoffInput, key: string): HandoffPrepareFailure | undefined {
  if (!input.humanQueueEnabled) return 'queue_unavailable';
  const queue = queueByKey(input.snapshot, key);
  if (!queue) return 'queue_unknown';
  const { hours } = queue.definition;
  if (hours && !open(hours, input.host.now())) return 'queue_closed';
  return input.faults.queues[key];
}

function open(hours: Parameters<typeof isOpen>[0], at: number): boolean {
  try {
    return isOpen(hours, at);
  } catch {
    // An unknown zone cannot pass publish; if one arrives the queue reads closed, as in the worker.
    return false;
  }
}
