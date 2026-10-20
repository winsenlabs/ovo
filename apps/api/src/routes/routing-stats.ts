import { z } from 'zod';
import { ROUTING_STATS_WINDOWS, type RoutingStats } from '@winsendotai/ovo-contracts';
import { foldRouteStats } from '@winsendotai/ovo-plugin-storage/outcomes';
import { routed, sendError, type RoutingRouteDependencies } from './routing-support.ts';

const StatsQuery = z
  .object({
    window: z.enum(ROUTING_STATS_WINDOWS).default('24h'),
    pointId: z.uuid().optional(),
  })
  .strict();
const WINDOW_MS = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 } as const;

/**
 * `GET /v1/routing/stats` (R4 design 6): routed calls, fallbacks, people reached and route time over
 * 24 hours, 7 days or 30 days, folded from the call outcomes. Without an outcomes store (an SQLite
 * installation) it says `available: false` rather than reporting zeros as fact.
 */
export function registerRoutingStatsRoutes(input: RoutingRouteDependencies): void {
  input.app.get(
    '/v1/routing/stats',
    routed(input, 'viewer', async ({ request, reply, principal }) => {
      const parsed = StatsQuery.safeParse(request.query);
      if (!parsed.success)
        return sendError(reply, 422, 'routing_stats_invalid', 'The stats query is invalid', {
          issues: parsed.error.issues,
        });
      const { window, pointId } = parsed.data;
      const until = (input.clock ?? Date.now)();
      const query = {
        since: new Date(until - WINDOW_MS[window]).toISOString(),
        until: new Date(until).toISOString(),
        bucket: window === '24h' ? ('hour' as const) : ('day' as const),
        ...(pointId ? { pointId } : {}),
      };
      const available = input.outcomes?.available === true;
      // Without an outcomes store nothing was counted: no buckets, and `available: false` says so.
      const stats = available
        ? await (await input.outcomes!.open()).routeStats(principal.workspaceId, query)
        : { ...foldRouteStats([], query), series: [] };
      const result: RoutingStats = {
        available,
        window,
        since: query.since,
        until: query.until,
        bucket: query.bucket,
        ...stats,
      };
      return result;
    }),
  );
}
