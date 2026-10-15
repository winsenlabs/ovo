import type { Pool } from 'pg';
import type {
  MemberClaim,
  RoutingMemberCandidate,
  RoutingPoint,
  RoutingPointDraft,
  RoutingPool,
  RoutingPoolDefinition,
  RoutingRelease,
  RoutingReleaseSnapshot,
} from '@winsendotai/ovo-contracts';
import { RoutingClaims } from './claims.ts';
import { RoutingPoints } from './points.ts';
import { RoutingPools } from './pools.ts';
import { RoutingReleases } from './releases.ts';

/** Wave 15 routing storage (design 5.2), organization-scoped. Frozen for the api and worker lanes. */
export interface RoutingService {
  /** OVO_ROUTING_ENABLED: off, admission sends routed numbers to their default agent. */
  readonly enabled: boolean;
  pools: {
    /** Ordered by id. */
    list(limit: number, cursor?: string): Promise<RoutingPool[]>;
    /** Excludes deleted. */
    get(id: string): Promise<RoutingPool | undefined>;
    /** Throws RoutingPoolNameTakenError when an active pool has the name. */
    create(definition: RoutingPoolDefinition): Promise<RoutingPool>;
    /** Undefined = conflict. */
    update(
      id: string,
      definition: RoutingPoolDefinition,
      expectedVersion: number,
    ): Promise<RoutingPool | undefined>;
    remove(
      id: string,
      expectedVersion: number,
    ): Promise<'removed' | 'conflict' | { inUseBy: string[] }>;
  };
  points: {
    list(limit: number, cursor?: string): Promise<RoutingPoint[]>;
    get(id: string): Promise<RoutingPoint | undefined>;
    create(draft: RoutingPointDraft): Promise<RoutingPoint>;
    update(
      id: string,
      draft: RoutingPointDraft,
      expectedVersion: number,
    ): Promise<RoutingPoint | undefined>;
    /** `pinnedBy` lists the pinning numbers, masked. */
    remove(
      id: string,
      expectedVersion: number,
    ): Promise<'removed' | 'conflict' | { pinnedBy: string[] }>;
  };
  releases: {
    /** Assigns version = max + 1 under an advisory lock; undefined when the draft moved past draftVersion. */
    create(input: {
      pointId: string;
      draftVersion: number;
      snapshot: RoutingReleaseSnapshot;
      digest: string;
      createdBy: string;
    }): Promise<RoutingRelease | undefined>;
    get(id: string): Promise<RoutingRelease | undefined>;
    /** Newest first. */
    list(pointId: string, limit: number, cursor?: string): Promise<RoutingRelease[]>;
  };
  claims: {
    claim(input: {
      callId: string;
      routingReleaseId: string;
      ttlSeconds: number;
      tiers: readonly (readonly RoutingMemberCandidate[])[];
    }): Promise<MemberClaim>;
    /** Releases every active claim of the call; returns how many. */
    release(callId: string): Promise<number>;
    active(poolId: string): Promise<Record<string, number>>;
  };
}

export class PostgresRoutingService implements RoutingService {
  readonly pools: RoutingPools;
  readonly points: RoutingPoints;
  readonly releases: RoutingReleases;
  readonly claims: RoutingClaims;

  constructor(
    pool: Pool,
    organizationId: string,
    readonly enabled: boolean,
  ) {
    this.pools = new RoutingPools(pool, organizationId);
    this.points = new RoutingPoints(pool, organizationId);
    this.releases = new RoutingReleases(pool, organizationId);
    this.claims = new RoutingClaims(pool, organizationId);
  }
}
