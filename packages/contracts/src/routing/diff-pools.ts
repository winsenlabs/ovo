import type { RoutingDiffInput } from './diff-model.ts';
import {
  changedFields,
  indexBy,
  isSnapshot,
  joinNames,
  same,
  type AddChange,
} from './diff-util.ts';
import type { PoolSnapshot } from './point.ts';
import { routingPoolIds } from './transfer.ts';

function diffPool(add: AddChange, before: PoolSnapshot, after: PoolSnapshot): void {
  const fields = changedFields(
    { name: before.name, languageFallback: before.languageFallback },
    { name: after.name, languageFallback: after.languageFallback },
  );
  const version =
    before.version === after.version ? '' : `, v${before.version} to v${after.version}`;
  const path = ['pools', after.id];
  if (fields.length)
    add(
      'pool',
      'changed',
      `pool ${after.name}`,
      path,
      `Pool ${after.name} changed (${joinNames(fields)}${version})`,
      {
        before: { name: before.name, languageFallback: before.languageFallback },
        after: { name: after.name, languageFallback: after.languageFallback },
      },
    );
  const was = indexBy(before.members, (member) => member.id);
  const now = indexBy(after.members, (member) => member.id);
  for (const [id, { item, index }] of now) {
    const old = was.get(id);
    const key = `pool ${after.name} / member ${id}`;
    const at = [...path, 'members', index];
    if (!old)
      add('member', 'added', key, at, `Member ${id} added to pool ${after.name}`, { after: item });
    else if (!same(old.item, item))
      add(
        'member',
        'changed',
        key,
        at,
        `Member ${id} of pool ${after.name} changed (${joinNames(changedFields(old.item, item))})`,
        { before: old.item, after: item },
      );
  }
  for (const [id, { item, index }] of was)
    if (!now.has(id))
      add(
        'member',
        'removed',
        `pool ${after.name} / member ${id}`,
        [...path, 'members', index],
        `Member ${id} removed from pool ${after.name}`,
        { before: item },
      );
}

/** Pool contents when both sides are snapshots, else which pools the trees name. */
export function diffPools(
  add: AddChange,
  before: RoutingDiffInput | undefined,
  after: RoutingDiffInput,
) {
  if (before && isSnapshot(before) && isSnapshot(after)) {
    for (const [id, pool] of Object.entries(after.pools)) {
      const old = before.pools[id];
      if (!old)
        add('pool', 'added', `pool ${pool.name}`, ['pools', id], `Pool ${pool.name} added`, {
          after: pool,
        });
      else diffPool(add, old, pool);
    }
    for (const [id, pool] of Object.entries(before.pools))
      if (!Object.hasOwn(after.pools, id))
        add('pool', 'removed', `pool ${pool.name}`, ['pools', id], `Pool ${pool.name} removed`, {
          before: pool,
        });
    return;
  }
  const was = new Set(before ? routingPoolIds(before) : []);
  const now = new Set(routingPoolIds(after));
  for (const id of now)
    if (!was.has(id)) add('pool', 'added', `pool ${id}`, ['pools', id], `Pool ${id} is now used`);
  for (const id of was)
    if (!now.has(id))
      add('pool', 'removed', `pool ${id}`, ['pools', id], `Pool ${id} is no longer used`);
}
