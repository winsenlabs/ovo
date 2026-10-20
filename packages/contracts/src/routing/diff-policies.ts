import type { RoutingDiffInput } from './diff-model.ts';
import {
  changedFields,
  indexBy,
  isSnapshot,
  joinNames,
  same,
  type AddChange,
} from './diff-util.ts';
import type { RoutingTransferPolicy } from './transfer.ts';
import { diffPools } from './diff-pools.ts';
import type { RoutingPointDraft, RoutingReleaseSnapshot } from './point.ts';

const TRANSFER_SCALARS = ['announcement', 'queueAnnouncement', 'confirm', 'handover'] as const;

function diffTransfer(
  add: AddChange,
  before: RoutingTransferPolicy | undefined,
  after: RoutingTransferPolicy | undefined,
): void {
  if (!before && !after) return;
  if (!before || !after) {
    add(
      'transfer',
      before ? 'removed' : 'added',
      'transfer policy',
      ['transfer'],
      before ? 'Transfer catalogue removed' : 'Transfer catalogue added',
      { before, after },
    );
    return;
  }
  const scalars = TRANSFER_SCALARS.filter((field) => !same(before[field], after[field]));
  if (scalars.length)
    add(
      'transfer',
      'changed',
      'transfer policy',
      ['transfer'],
      `Transfer defaults changed (${joinNames(scalars)})`,
    );
  if (!same(before.limits, after.limits))
    add(
      'limits',
      'changed',
      'transfer limits',
      ['transfer', 'limits'],
      `Transfer limits changed (${joinNames(changedFields(before.limits, after.limits))})`,
      { before: before.limits, after: after.limits },
    );
  if (!same(before.hold, after.hold))
    add(
      'hold',
      before.hold ? (after.hold ? 'changed' : 'removed') : 'added',
      'transfer hold',
      ['transfer', 'hold'],
      'Point hold policy changed',
      { before: before.hold, after: after.hold },
    );
  const was = indexBy(before.targets, (target) => target.key);
  const now = indexBy(after.targets, (target) => target.key);
  for (const [key, { item, index }] of now) {
    const old = was.get(key);
    const path = ['transfer', 'targets', index];
    if (!old) {
      add('transfer', 'added', `transfer target ${key}`, path, `Transfer target ${key} added`, {
        after: item,
      });
      continue;
    }
    const { hold: oldHold, ...oldRest } = old.item;
    const { hold: newHold, ...newRest } = item;
    if (!same(oldRest, newRest))
      add(
        'transfer',
        'changed',
        `transfer target ${key}`,
        path,
        `Transfer target ${key} changed (${joinNames(changedFields(oldRest, newRest))})`,
        { before: oldRest, after: newRest },
      );
    if (!same(oldHold, newHold))
      add(
        'hold',
        oldHold ? (newHold ? 'changed' : 'removed') : 'added',
        `transfer target ${key} / hold`,
        [...path, 'hold'],
        `Hold of transfer target ${key} changed`,
        { before: oldHold, after: newHold },
      );
  }
  for (const [key, { item, index }] of was)
    if (!now.has(key))
      add(
        'transfer',
        'removed',
        `transfer target ${key}`,
        ['transfer', 'targets', index],
        `Transfer target ${key} removed`,
        { before: item },
      );
}

function diffQueues(
  add: AddChange,
  before: RoutingPointDraft | undefined,
  after: RoutingPointDraft,
  snapshots: { before?: RoutingReleaseSnapshot; after?: RoutingReleaseSnapshot },
): void {
  const was = indexBy(before?.humanQueues ?? [], (binding) => binding.key);
  const now = indexBy(after.humanQueues ?? [], (binding) => binding.key);
  for (const [key, { item, index }] of now) {
    const old = was.get(key);
    const path = ['humanQueues', index];
    if (!old)
      add('queue', 'added', `queue ${key}`, path, `Human queue ${key} bound`, { after: item });
    else if (!same(old.item, item))
      add(
        'queue',
        'changed',
        `queue ${key}`,
        path,
        `Human queue ${key} binding changed (${joinNames(changedFields(old.item, item))})`,
        { before: old.item, after: item },
      );
    else if (snapshots.before && snapshots.after) {
      const pinned = snapshots.before.queues[item.queueId];
      const next = snapshots.after.queues[item.queueId];
      if (pinned && next && !same(pinned, next))
        add(
          'queue',
          'changed',
          `queue ${key}`,
          ['queues', item.queueId],
          pinned.version === next.version
            ? `Human queue ${key} definition changed`
            : `Human queue ${key} definition changed (v${pinned.version} to v${next.version})`,
          { before: pinned, after: next },
        );
    }
  }
  for (const [key, { item, index }] of was)
    if (!now.has(key))
      add(
        'queue',
        'removed',
        `queue ${key}`,
        ['humanQueues', index],
        `Human queue ${key} unbound`,
        { before: item },
      );
}

/** Transfer catalogue, holds, human queue bindings and pools. */
export function diffPolicies(
  add: AddChange,
  before: RoutingDiffInput | undefined,
  after: RoutingDiffInput,
): void {
  diffTransfer(add, before?.transfer, after.transfer);
  diffQueues(add, before, after, {
    ...(before && isSnapshot(before) ? { before } : {}),
    ...(isSnapshot(after) ? { after } : {}),
  });
  diffPools(add, before, after);
}
