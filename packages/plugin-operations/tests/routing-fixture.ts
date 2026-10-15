import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  RoutingPointDraft,
  RoutingPoolDefinition,
  RoutingReleaseSnapshot,
  type RoutingRelease,
} from '@winsendotai/ovo-contracts';
import { routingSnapshotDigest, type RoutingService } from '../src/index.ts';

/** A throwaway schema, dropped at the end: routing releases cannot be deleted row by row. */
export async function routingSchema(url: string) {
  const schema = `ovo_routing_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 25 });
  return {
    schema,
    pool,
    async drop() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

export interface ReleaseIds {
  router: string;
  fallback: string;
  en: string;
  hi: string;
}

export function releaseIds(): ReleaseIds {
  return { router: randomUUID(), fallback: randomUUID(), en: randomUUID(), hi: randomUUID() };
}

export function salesPool(ids: ReleaseIds, name = 'Sales'): RoutingPoolDefinition {
  return RoutingPoolDefinition.parse({
    name,
    languageFallback: ['en'],
    members: [
      {
        id: 'sales-en',
        agent: { agentId: 'sales-en', release: { kind: 'latest' } },
        languages: ['en'],
      },
      {
        id: 'sales-hi',
        agent: { agentId: 'sales-hi', release: { kind: 'latest' } },
        languages: ['hi'],
      },
    ],
  });
}

export function salesDraft(poolId: string, name = 'Main line'): RoutingPointDraft {
  return RoutingPointDraft.parse({
    name,
    router: { agentId: 'front-desk', release: { kind: 'latest' } },
    defaultTarget: { agentId: 'sales-en', release: { kind: 'latest' } },
    language: { default: 'en', allowed: ['en', 'hi'] },
    greeting: { en: 'Welcome. How can I help you today?' },
    root: 'intent',
    nodes: [
      {
        id: 'intent',
        ask: { en: 'Are you calling about sales?' },
        engines: [{ kind: 'llm', instructions: 'Decide why the caller is calling.' }],
        branches: [
          {
            key: 'sales',
            description: 'Wants to buy',
            target: { kind: 'pool', poolId, language: 'caller' },
          },
        ],
        fallback: [{ kind: 'default' }],
      },
    ],
  });
}

/** The draft frozen with every reference pinned. */
export function salesSnapshot(
  pointId: string,
  poolId: string,
  ids: ReleaseIds,
  draft = salesDraft(poolId),
): RoutingReleaseSnapshot {
  const pinned = (agentId: string, releaseId: string) => ({
    agentId,
    release: { kind: 'pinned' as const, releaseId },
  });
  return RoutingReleaseSnapshot.parse({
    ...draft,
    schemaVersion: 1,
    routingPointId: pointId,
    router: pinned('front-desk', ids.router),
    defaultTarget: pinned('sales-en', ids.fallback),
    pools: {
      [poolId]: {
        id: poolId,
        version: 1,
        name: 'Sales',
        languageFallback: ['en'],
        members: [
          { id: 'sales-en', agent: pinned('sales-en', ids.en), languages: ['en'] },
          { id: 'sales-hi', agent: pinned('sales-hi', ids.hi), languages: ['hi'] },
        ],
      },
    },
    releaseIds: [ids.router, ids.fallback, ids.en, ids.hi],
  });
}

/** Creates a pool and a point, then publishes one release of it. */
export async function publishedRelease(
  routing: RoutingService,
  ids: ReleaseIds,
  name = `Sales ${randomUUID()}`,
): Promise<RoutingRelease> {
  const pool = await routing.pools.create(salesPool(ids, name));
  const point = await routing.points.create(salesDraft(pool.id, name));
  const snapshot = salesSnapshot(point.id, pool.id, ids);
  const release = await routing.releases.create({
    pointId: point.id,
    draftVersion: point.draftVersion,
    snapshot,
    digest: routingSnapshotDigest(snapshot),
    createdBy: 'user:tester',
  });
  if (!release) throw new Error('publish failed');
  return release;
}
