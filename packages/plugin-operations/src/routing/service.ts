import type { Pool } from 'pg';
import type {
  MemberClaim,
  RoutingAudio,
  RoutingMemberCandidate,
  RoutingPoint,
  RoutingPointDraft,
  RoutingPool,
  RoutingPoolDefinition,
  RoutingRelease,
  RoutingReleaseSnapshot,
} from '@winsendotai/ovo-contracts';
import { RoutingAudioStore, type RoutingAudioInput } from './audio.ts';
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
    /** Excludes deleted unless `includeDeleted`; a deleted pool carries `deletedAt` (R2). */
    get(
      id: string,
      options?: { includeDeleted?: boolean },
    ): Promise<(RoutingPool & { deletedAt?: string }) | undefined>;
    /** Live point ids whose current draft names the pool (`ovo_routing_point_pools`; R2). */
    usedBy(id: string): Promise<string[]>;
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
  /** create/update keep `ovo_routing_point_pools` and `ovo_routing_point_audio` to the draft. */
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
  /** R2 hold clips: immutable 8 kHz mu-law bytes, soft-deleted, pinned by sha256 in releases. */
  audio: {
    /** Metadata only, by id; deleted clips left out. */
    list(limit: number, cursor?: string): Promise<RoutingAudio[]>;
    get(id: string, options?: { includeDeleted?: boolean }): Promise<RoutingAudio | undefined>;
    /** The bytes, deleted or not (pinned releases); undefined when unknown or the digest differs. */
    content(id: string, sha256: string): Promise<Uint8Array | undefined>;
    create(input: RoutingAudioInput): Promise<RoutingAudio | 'name_taken'>;
    usedBy(id: string): Promise<string[]>;
    remove(id: string): Promise<'removed' | 'missing' | { inUseBy: string[] }>;
  };
  claims: {
    /**
     * One active claim per call, idempotent for the same member, advisory-locked. The call's
     * previous claim is released only when a new one is taken (same transaction); `full` leaves
     * it in place (R2).
     */
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
  readonly audio: RoutingAudioStore;

  constructor(
    pool: Pool,
    organizationId: string,
    readonly enabled: boolean,
  ) {
    this.pools = new RoutingPools(pool, organizationId);
    this.points = new RoutingPoints(pool, organizationId);
    this.releases = new RoutingReleases(pool, organizationId);
    this.claims = new RoutingClaims(pool, organizationId);
    this.audio = new RoutingAudioStore(pool, organizationId);
  }
}
