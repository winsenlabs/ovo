import { z } from 'zod';
import { RouteUuid, RoutingKey } from './ids.ts';

const Count = z.number().int().nonnegative();
const Capacity = z.number().int().positive().nullable();

/** `GET /v1/routing/pools/:id/utilisation`: active claims against each member's capacity. */
export const PoolUtilisation = z.object({
  poolId: RouteUuid,
  at: z.iso.datetime(),
  members: z.array(
    z.object({
      memberId: RoutingKey,
      active: Count,
      /** Null: unlimited (still counted, for balancing). */
      capacity: Capacity,
      enabled: z.boolean(),
      /** Null when the member has no hours. */
      open: z.boolean().nullable(),
    }),
  ),
  total: z.object({ active: Count, capacity: Capacity }),
});
export type PoolUtilisation = z.infer<typeof PoolUtilisation>;

/** `GET /v1/routing/utilisation`: every pool of the workspace, one query. */
export const RoutingUtilisation = z.object({
  at: z.iso.datetime(),
  pools: z.array(
    z.object({
      poolId: RouteUuid,
      active: Count,
      capacity: Capacity,
      /** Members without a capacity (counted in `active`, not in `capacity`). */
      unlimitedMembers: Count,
    }),
  ),
});
export type RoutingUtilisation = z.infer<typeof RoutingUtilisation>;
