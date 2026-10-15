import type { SegmentHandoffRequest, TransferTarget } from '@winsendotai/ovo-contracts';
import type { HumanRefusal, QueueSnapshot } from './human-contract.ts';
import { humanRequested, type HumanSource } from './human-events.ts';
import type { HoldSource, ConnectHost, TransferRun } from './transfer-types.ts';
import type { HumanTarget, SegmentReason, TransferAttempt } from './transfer-attempt.ts';

type HumanRequest = Extract<SegmentHandoffRequest, { kind: 'human' }>;

/** A queue as an attempt's target: the history names it `queue:<key>` (human queue design 7.1). */
export function humanTarget(
  queue: { key: string; id: string; definition: { kind: 'external' | 'managed' } },
  reason: SegmentReason,
): HumanTarget {
  return {
    ...{ role: 'human', reason, kind: queue.definition.kind },
    ...{ queueKey: queue.key, queueId: queue.id },
    ...{ agentId: `queue:${queue.key}`, releaseId: queue.id },
  };
}

/** The source a `human.requested` event records for a request (design 4.7). */
function humanSource(request: HumanRequest): HumanSource {
  return request.transfer?.source ?? 'router';
}

/** Records a refused request against the queue it named, when the release binds that key. */
function refuse(
  host: ConnectHost,
  run: TransferRun,
  key: string,
  source: HumanSource,
  refusal: HumanRefusal,
): HumanRefusal {
  const queue = host.deps.human?.queue(key);
  // A key the release does not bind names no queue: the refusal is on the route / transfer events.
  if (queue)
    host.deps.record(
      'human.requested',
      humanRequested(
        { key, id: queue.id, kind: queue.definition.kind },
        {
          source,
          result: 'refused',
          refusal,
          ...(run.transfer !== undefined ? { transfer: run.transfer } : {}),
        },
      ),
    );
  host.deps.log('human_failed', { queue: key, refusal });
  return refusal;
}

/** A human attempt for `queue` on a fresh held lease: idle until `commit` makes the ticket. */
function openAttempt(
  host: ConnectHost,
  run: TransferRun,
  input: {
    queue: QueueSnapshot;
    source: HumanSource;
    reason: SegmentReason;
    waitSeconds: number;
    catalogue?: TransferTarget | undefined;
  },
): TransferAttempt | undefined {
  const { queue } = input;
  const { meta } = run;
  return host.humanAttempt(run, (index, lease) =>
    host.deps.human!.attempt({
      ...{ index, lease, queue, source: input.source, from: run.from },
      target: humanTarget(queue, input.reason),
      waitSeconds: input.waitSeconds,
      ...(run.transfer !== undefined ? { transfer: run.transfer } : {}),
      ...(input.catalogue ? { catalogue: input.catalogue } : {}),
      ...(meta?.summary || meta?.reason
        ? {
            meta: {
              ...(meta.summary ? { summary: meta.summary } : {}),
              ...(meta.reason ? { reason: meta.reason } : {}),
            },
          }
        : {}),
    }),
  );
}

/**
 * A human handoff (human queue design 7.2): the queue's gates and precheck, with the call's hold
 * replaced by the queue's. Nothing is created: the attempt sits idle until `commit` makes the
 * ticket. A refusal is evented and returned for the router's chain or the agent's refusal text.
 * Undefined: the run now carries its attempt.
 */
export async function beginHuman(
  host: ConnectHost,
  run: TransferRun,
  request: HumanRequest,
  target: TransferTarget | undefined,
): Promise<HumanRefusal | 'human_queue_unavailable' | undefined> {
  const { human } = host.deps;
  // No human queues composed (flags off): the R2 answer, which the router skips and logs.
  if (!human) return 'human_queue_unavailable';
  const source = humanSource(request);
  const checked = await human.precheck(request.queueId);
  if (!checked.ok) return refuse(host, run, request.queueId, source, checked.reason);
  const { queue } = checked;
  run.hold = human.hold(queue, target);
  run.human = { queue, source };
  run.queuesTried = [request.queueId];
  run.attempt = openAttempt(host, run, {
    queue,
    source,
    reason: request.reason === 'route' ? 'route' : 'transfer',
    waitSeconds: run.hold.policy.maxSeconds,
    catalogue: target,
  });
  return run.attempt ? undefined : 'queue_unavailable';
}

/**
 * An overflow queue (design 7.6): the hold's chain names a queue the run has not tried (a chain
 * never revisits one: `queue_loop`), it passes the same gates as a first request, and its attempt
 * starts at once (the chain's candidates are committed). It waits as long as the queue's own hold
 * says, not the chain's default step wait.
 */
export async function humanStep(
  host: ConnectHost,
  run: TransferRun,
  key: string,
): Promise<{ attempt: TransferAttempt; seconds: number } | string> {
  const { human } = host.deps;
  if (!human) return 'queue_unavailable';
  if (run.queuesTried?.includes(key)) return 'queue_loop';
  const checked = await human.precheck(key);
  if (!checked.ok) return refuse(host, run, key, 'chain', checked.reason);
  const { queue } = checked;
  const seconds = human.hold(queue).policy.maxSeconds;
  run.queuesTried = [...(run.queuesTried ?? []), key];
  run.human = { queue, source: 'chain' };
  const attempt = openAttempt(host, run, {
    queue,
    source: 'chain',
    reason: run.transfer !== undefined ? 'transfer' : 'fallback',
    waitSeconds: seconds,
  });
  if (!attempt) return 'segments_exhausted';
  attempt.commit?.();
  return { attempt, seconds };
}

export type { HoldSource };
