import { z } from 'zod';
import {
  RouteContextKey,
  RouteLanguage,
  RoutingKey,
  RoutingPoolDefinition,
  RoutingPoolTarget,
  type PoolConsideration,
  type PoolSnapshot,
  type PoolUtilisation,
  type RoutingPool,
  type RoutingUtilisation,
} from '@winsendotai/ovo-contracts';
import { isOpen } from '@winsendotai/ovo-plugin-router';
import { releaseResolver } from '../routing-publish-resolve.ts';
import { poolOr404 } from './routing-pools.ts';
import {
  routed,
  sendError,
  type RoutingR4Dependencies,
  type RoutingRouteDependencies,
} from './routing-support.ts';

/** A release the pool's member has no published release for; the explanation never reads it. */
const NO_RELEASE = '00000000-0000-4000-8000-000000000000';
/** Pools read for the overview (the list is capped by the pool limit of a workspace). */
const OVERVIEW_PAGE = 100;
const OVERVIEW_PAGES = 5;

/**
 * The target a caller is routed by. The console sends a whole pool target (with its `kind` and
 * `poolId`); the pool is the body's, so those two are accepted and ignored.
 */
const ExplainTarget = z
  .object({
    kind: z.literal('pool').optional(),
    poolId: z.uuid().optional(),
    language: z.enum(['caller', 'any']).default('caller'),
    products: RoutingPoolTarget.shape.products,
    skills: z.array(RoutingKey).max(10).default([]),
  })
  .strict();
/** What the call knows so far: the language, and context values (`product` is the common one). */
const ExplainContext = z
  .object({
    language: RouteLanguage.optional(),
    product: RoutingKey.optional(),
    values: z.record(RouteContextKey, RoutingKey).default({}),
  })
  .strict()
  .transform(({ product, values, ...rest }) => ({
    ...rest,
    values: { ...(product ? { product } : {}), ...values },
  }));

const ExplainBody = z
  .object({
    poolId: z.uuid().optional(),
    definition: RoutingPoolDefinition.optional(),
    target: ExplainTarget.default({ language: 'caller', skills: [] }),
    context: ExplainContext.default({ values: {} }),
    defaultLanguage: RouteLanguage.default('en'),
    at: z.iso.datetime().optional(),
    load: z.enum(['empty', 'live']).default('empty'),
    fullMembers: z.array(RoutingKey).max(100).default([]),
    waitForCapacity: z.boolean().default(false),
  })
  .strict()
  .refine((body) => (body.poolId === undefined) !== (body.definition === undefined), {
    message: 'Give exactly one of poolId or definition',
    path: ['poolId'],
  })
  .refine((body) => body.target.poolId === undefined || body.target.poolId === body.poolId, {
    message: 'The target names another pool than the body',
    path: ['target', 'poolId'],
  });

/** Capacity of the members that can take a call, or null when none of them is bounded. */
function capacityOf(pool: RoutingPool): { capacity: number | null; unlimited: number } {
  let capacity: number | null = null;
  let unlimited = 0;
  for (const member of pool.definition.members) {
    if (!member.enabled) continue;
    if (member.capacity === undefined) unlimited += 1;
    else capacity = (capacity ?? 0) + member.capacity;
  }
  return { capacity, unlimited };
}

const total = (members: Record<string, number> | undefined) =>
  Object.values(members ?? {}).reduce((sum, active) => sum + active, 0);

/**
 * Pool utilisation (R4 design 7.4) and "who would answer" (`pools/explain`). Utilisation is the
 * members' active claims against their capacity, read in one query; the explanation runs the
 * router's own eligibility and ranking over a pool, with no claim taken.
 */
export function registerRoutingUtilisationRoutes(input: RoutingR4Dependencies): void {
  const { app } = input;
  const now = () => (input.clock ?? Date.now)();

  app.get(
    '/v1/routing/utilisation',
    routed(input, 'viewer', async ({ routing }): Promise<RoutingUtilisation> => {
      const pools: RoutingPool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < OVERVIEW_PAGES; page += 1) {
        const found = await routing.pools.list(OVERVIEW_PAGE, cursor);
        pools.push(...found);
        if (found.length < OVERVIEW_PAGE) break;
        cursor = found.at(-1)!.id;
      }
      const active = await routing.claims.activeByPool(pools.map((pool) => pool.id));
      return {
        at: new Date(now()).toISOString(),
        pools: pools.map((pool) => {
          const { capacity, unlimited } = capacityOf(pool);
          return {
            poolId: pool.id,
            active: total(active[pool.id]),
            capacity,
            unlimitedMembers: unlimited,
          };
        }),
      };
    }),
  );

  app.get(
    '/v1/routing/pools/:poolId/utilisation',
    routed(input, 'viewer', async ({ request, reply, routing }) => {
      const pool = await poolOr404(routing, request, reply);
      if (!pool) return;
      const at = now();
      const active = (await routing.claims.activeByPool([pool.id]))[pool.id] ?? {};
      const result: PoolUtilisation = {
        poolId: pool.id,
        at: new Date(at).toISOString(),
        members: pool.definition.members.map((member) => ({
          memberId: member.id,
          active: active[member.id] ?? 0,
          capacity: member.capacity ?? null,
          enabled: member.enabled,
          open: member.hours ? isOpen(member.hours, at) : null,
        })),
        total: { active: total(active), capacity: capacityOf(pool).capacity },
      };
      return result;
    }),
  );

  registerExplain(input);
}

function registerExplain(input: RoutingRouteDependencies): void {
  const now = () => (input.clock ?? Date.now)();
  input.app.post(
    '/v1/routing/pools/explain',
    routed(input, 'viewer', async ({ request, reply, principal, routing }) => {
      const parsed = ExplainBody.safeParse(request.body ?? {});
      if (!parsed.success)
        return sendError(
          reply,
          422,
          'routing_explain_invalid',
          'The explanation request is invalid',
          {
            issues: parsed.error.issues,
          },
        );
      const body = parsed.data;
      if (!input.simulator)
        return sendError(
          reply,
          503,
          'routing_simulator_unavailable',
          'The router cannot explain pools here',
        );
      const stored = body.poolId ? await routing.pools.get(body.poolId) : undefined;
      if (body.poolId && !stored)
        return sendError(reply, 404, 'routing_pool_not_found', 'Pool not found');
      const definition = stored?.definition ?? body.definition!;
      const resolve = releaseResolver(input.store, principal.workspaceId);
      const snapshot: PoolSnapshot = {
        id: stored?.id ?? NO_RELEASE,
        version: stored?.version ?? 1,
        name: definition.name,
        languageFallback: definition.languageFallback,
        members: await Promise.all(
          definition.members.map(async (member) => ({
            ...member,
            agent: {
              agentId: member.agent.agentId,
              release: {
                kind: 'pinned' as const,
                releaseId: (await resolve(member.agent))?.id ?? NO_RELEASE,
              },
            },
          })),
        ),
      };
      const load =
        body.load === 'live' && stored ? await routing.claims.active(stored.id) : undefined;
      const explained: PoolConsideration = {
        ...input.simulator.explainPool({
          pool: snapshot,
          target: {
            kind: 'pool',
            poolId: snapshot.id,
            language: body.target.language,
            skills: body.target.skills,
            ...(body.target.products ? { products: body.target.products } : {}),
          },
          context: body.context,
          defaultLanguage: body.defaultLanguage,
          now: body.at ? Date.parse(body.at) : now(),
          ...(load ? { load } : {}),
          fullMembers: new Set(body.fullMembers),
          waitForCapacity: body.waitForCapacity,
        }),
        turn: null,
        node: null,
      };
      return explained;
    }),
  );
}
