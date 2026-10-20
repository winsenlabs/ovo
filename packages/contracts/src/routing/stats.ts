import { z } from 'zod';

export const ROUTING_STATS_WINDOWS = ['24h', '7d', '30d'] as const;
export type RoutingStatsWindow = (typeof ROUTING_STATS_WINDOWS)[number];

const Count = z.number().int().nonnegative();
const Ms = z.number().nonnegative().nullable();

/** `GET /v1/routing/stats`: folded from the call outcomes. `{ available: false }` without an outcomes store. */
export const RoutingStats = z.object({
  available: z.boolean(),
  window: z.enum(ROUTING_STATS_WINDOWS),
  since: z.iso.datetime(),
  until: z.iso.datetime(),
  bucket: z.enum(['hour', 'day']),
  totals: z.object({
    routed: Count,
    undecided: Count,
    byTarget: z.object({ agent: Count, human: Count, end: Count, callback: Count }),
    degraded: Count,
    withFallback: Count,
    withReask: Count,
    transferred: Count,
    reachedPerson: Count,
    avgTurns: z.number().nonnegative().nullable(),
    routeMsP50: Ms,
    routeMsP95: Ms,
  }),
  series: z.array(
    z.object({
      at: z.iso.datetime(),
      routed: Count,
      agent: Count,
      human: Count,
      end: Count,
      callback: Count,
      fallback: Count,
    }),
  ),
  /** Top 50 by routed calls. */
  points: z.array(
    z.object({ pointId: z.string(), routed: Count, withFallback: Count, human: Count }),
  ),
  pools: z.array(
    z.object({ poolId: z.string(), picks: Count, byMember: z.record(z.string(), Count) }),
  ),
});
export type RoutingStats = z.infer<typeof RoutingStats>;
