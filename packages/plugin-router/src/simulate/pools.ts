import { effectiveHold, type RoutingReleaseSnapshot } from '@winsendotai/ovo-contracts';
import { explainPool } from '../explain.ts';
import type { PoolAttempt } from '../ports.ts';
import type { PoolConsideration } from '../wire/index.ts';
import type { SimClock } from './host.ts';

/** The entries of a `poolId:memberId`-keyed record that belong to one pool, keyed by member id. */
function ofPool<T>(record: Readonly<Record<string, T>>, poolId: string): Record<string, T> {
  const prefix = `${poolId}:`;
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [key.slice(prefix.length), value]),
  );
}

/**
 * Collects a `PoolConsideration` for every pool target the router attempts, read with the same
 * clock, load and capacity faults the simulated host claims with, so the explanation and the pick
 * cannot differ.
 */
export function poolObserver(input: {
  snapshot: RoutingReleaseSnapshot;
  clock: SimClock;
  load: Readonly<Record<string, number>>;
  /** `poolId:memberId` keys held at capacity by a fault. */
  full: ReadonlySet<string>;
  transferEnabled: boolean;
}) {
  const considered: PoolConsideration[] = [];
  const queues = input.transferEnabled && effectiveHold(input.snapshot.transfer).waitForCapacity;
  const faults = Object.fromEntries([...input.full].map((key) => [key, true]));
  return {
    considered,
    observe(attempt: PoolAttempt): void {
      const { poolId } = attempt.target;
      considered.push({
        ...explainPool({
          pool: input.snapshot.pools[poolId]!,
          target: attempt.target,
          context: attempt.context,
          defaultLanguage: input.snapshot.language.default,
          now: input.clock.now(),
          load: ofPool(input.load, poolId),
          fullMembers: new Set(Object.keys(ofPool(faults, poolId))),
          waitForCapacity: queues,
        }),
        turn: attempt.turn,
        node: attempt.node,
      });
    },
  };
}
