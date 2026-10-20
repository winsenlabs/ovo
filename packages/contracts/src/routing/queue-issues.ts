import { HUMAN_QUEUE_LIMITS, type QueueSnapshot } from '../human-queue/queue.ts';
import type { Add } from './issues.ts';
import type { RoutingPointDraft } from './point.ts';
import { routingNodeTargets, type RoutingPath } from './tree.ts';
import { transferHolds, type HoldPolicy, type RoutingTransferPolicy } from './transfer.ts';
import { holdIssues } from './transfer-issues.ts';

/** Every place a draft names a queue by key: tree targets and steps, human transfer targets, hold timeouts. */
export function queueKeyRefs(
  draft: Pick<RoutingPointDraft, 'nodes' | 'transfer'>,
): { path: RoutingPath; key: string }[] {
  const refs: { path: RoutingPath; key: string }[] = [];
  for (const { path, target } of routingNodeTargets(draft.nodes))
    if (target.kind === 'human') refs.push({ path: [...path, 'queueId'], key: target.queueId });
  draft.transfer?.targets.forEach((target, t) => {
    if (target.destination.kind === 'human')
      refs.push({
        path: ['transfer', 'targets', t, 'destination', 'queueId'],
        key: target.destination.queueId,
      });
  });
  for (const { path, hold } of transferHolds(draft.transfer))
    hold.onTimeout.forEach((step, s) => {
      if (step.kind === 'human')
        refs.push({ path: [...path, 'onTimeout', s, 'queueId'], key: step.queueId });
    });
  return refs;
}

/** A hold chain that names one queue twice, or the queue the hold already belongs to. */
function chainLoops(path: RoutingPath, hold: HoldPolicy, own: string | undefined, add: Add) {
  const seen = new Set(own === undefined ? [] : [own]);
  hold.onTimeout.forEach((step, s) => {
    if (step.kind !== 'human') return;
    if (seen.has(step.queueId))
      add(
        'routing_queue_chain_loop',
        [...path, 'onTimeout', s, 'queueId'],
        `The timeout chain reaches queue ${step.queueId} twice`,
      );
    seen.add(step.queueId);
  });
}

/** Return targets and the hold of one pinned queue against the point's transfer catalogue. */
export function queueDefinitionIssues(
  snapshot: Pick<QueueSnapshot, 'key' | 'definition'>,
  transfer: RoutingTransferPolicy | undefined,
  at: RoutingPath,
  add: Add,
): void {
  const { definition, key } = snapshot;
  const targets = new Set(transfer?.targets.map((target) => target.key));
  if (definition.kind === 'managed') {
    definition.returnTargets.forEach((target, i) => {
      if (!targets.has(target))
        add(
          'routing_queue_return_target_unknown',
          [...at, 'definition', 'returnTargets', i],
          `No transfer target ${target}`,
        );
    });
    if (definition.returnDefault !== undefined && !targets.has(definition.returnDefault))
      add(
        'routing_queue_return_target_unknown',
        [...at, 'definition', 'returnDefault'],
        `No transfer target ${definition.returnDefault}`,
      );
  }
  if (definition.hold) {
    const path = [...at, 'definition', 'hold'];
    holdIssues(path, definition.hold, targets, add, undefined, { queue: true });
    chainLoops(path, definition.hold, key, add);
  }
}

/**
 * R3 structural checks for `draft.humanQueues`: keys, references, unused bindings, chain loops, and
 * (on a release snapshot, which carries the pinned definitions) each queue's return targets and hold.
 * A draft without `humanQueues` raises nothing here: its `human` steps keep the R1/R2 warnings.
 */
export function queueDraftIssues(
  draft: RoutingPointDraft & { queues?: Record<string, QueueSnapshot> },
  add: Add,
): void {
  const bindings = draft.humanQueues ?? [];
  if (bindings.length === 0) return;
  const keys = new Set<string>();
  const ids = new Set<string>();
  bindings.forEach((binding, b) => {
    if (keys.has(binding.key))
      add(
        'routing_queue_key_duplicate',
        ['humanQueues', b, 'key'],
        `Queue key ${binding.key} is bound twice`,
      );
    keys.add(binding.key);
    if (ids.has(binding.queueId))
      add(
        'routing_queue_key_duplicate',
        ['humanQueues', b, 'queueId'],
        'A queue is bound once per point',
      );
    ids.add(binding.queueId);
  });
  if (bindings.length > HUMAN_QUEUE_LIMITS.queuesPerPoint)
    add(
      'routing_queue_limits_exceeded',
      ['humanQueues'],
      `At most ${HUMAN_QUEUE_LIMITS.queuesPerPoint} queues per point`,
    );
  const used = new Set<string>();
  for (const { path, key } of queueKeyRefs(draft)) {
    used.add(key);
    if (!keys.has(key)) add('routing_queue_unknown', path, `No queue bound as ${key}`);
  }
  bindings.forEach((binding, b) => {
    if (!used.has(binding.key))
      add(
        'routing_queue_unused',
        ['humanQueues', b],
        `Queue ${binding.key} is never used`,
        'warning',
      );
  });
  for (const { path, hold, key } of transferHolds(draft.transfer)) {
    const target = draft.transfer?.targets.find((candidate) => candidate.key === key);
    chainLoops(
      path,
      hold,
      target?.destination.kind === 'human' ? target.destination.queueId : undefined,
      add,
    );
  }
  for (const [id, queue] of Object.entries(draft.queues ?? {}))
    queueDefinitionIssues(queue, draft.transfer, ['queues', id], add);
}
