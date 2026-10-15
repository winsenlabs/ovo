import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { MemberClaim, RoutingMemberCandidate } from '@winsendotai/ovo-contracts';
import { transaction } from '../database.ts';
import { uuidOrNull } from './rows.ts';

export interface RoutingClaimInput {
  callId: string;
  routingReleaseId: string;
  ttlSeconds: number;
  tiers: readonly (readonly RoutingMemberCandidate[])[];
}

/** An active claim counts toward capacity until it is released or expires (a crashed worker). */
const ACTIVE = 'released_at IS NULL AND expires_at > now()';

/**
 * Soft per-member capacity: one active claim per call, counted per (pool, member). Advisory
 * locks on the call and on every candidate member serialise the count and the insert, so
 * parallel calls never overfill a member and a call never holds two claims.
 */
export class RoutingClaims {
  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
  ) {}

  async claim(input: RoutingClaimInput): Promise<MemberClaim> {
    if (input.callId.length < 1 || input.callId.length > 200) throw new Error('Invalid callId');
    if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > 86_400)
      throw new Error('ttlSeconds must be an integer between 1 and 86400');
    const tiers = input.tiers.map((tier) =>
      tier.filter((candidate) => uuidOrNull(candidate.poolId) && uuidOrNull(candidate.releaseId)),
    );
    return transaction(this.pool, async (client) => {
      await this.lock(client, [`call:${input.callId}`]);
      const held = await client.query<{ id: string; pool_id: string; member_id: string }>(
        `SELECT id, pool_id, member_id FROM ovo_routing_member_claims
         WHERE organization_id = $1 AND call_id = $2 AND ${ACTIVE}`,
        [this.organizationId, input.callId],
      );
      const prior = held.rows[0];
      const same = prior && tiers.flat().find((c) => sameMember(c, prior));
      if (same) return { kind: 'claimed', claimId: prior.id, candidate: same };
      // A call holds one claim: a re-route (or a lapsed claim) gives the earlier one back first.
      await client.query(
        `UPDATE ovo_routing_member_claims SET released_at = now()
         WHERE organization_id = $1 AND call_id = $2 AND released_at IS NULL`,
        [this.organizationId, input.callId],
      );
      // Every candidate member is locked up front in one sorted order (no deadlock between calls
      // whose tiers overlap), so the counts below stay true until this transaction commits.
      await this.lock(
        client,
        tiers.flat().map((c) => `member:${c.poolId}:${c.memberId}`),
      );
      for (const tier of tiers) {
        const [candidate] = await this.ranked(client, tier);
        if (!candidate) continue;
        const claimId = randomUUID();
        await client.query(
          `INSERT INTO ovo_routing_member_claims (organization_id, id, call_id,
             routing_release_id, pool_id, member_id, release_id, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8 * interval '1 second'))`,
          [
            this.organizationId,
            claimId,
            input.callId,
            input.routingReleaseId,
            candidate.poolId,
            candidate.memberId,
            candidate.releaseId,
            input.ttlSeconds,
          ],
        );
        return { kind: 'claimed', claimId, candidate };
      }
      return { kind: 'full' };
    });
  }

  private async lock(client: PoolClient, keys: readonly string[]): Promise<void> {
    for (const key of [...new Set(keys)].sort())
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `ovo-routing-claim:${this.organizationId}:${key}`,
      ]);
  }

  /** Releases every active claim of the call; returns how many. */
  async release(callId: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE ovo_routing_member_claims SET released_at = now()
       WHERE organization_id = $1 AND call_id = $2 AND released_at IS NULL`,
      [this.organizationId, callId],
    );
    return result.rowCount ?? 0;
  }

  /** Active claims per member of one pool. */
  async active(poolId: string): Promise<Record<string, number>> {
    if (!uuidOrNull(poolId)) return {};
    const result = await this.pool.query<{ member_id: string; active: number }>(
      `SELECT member_id, count(*)::int AS active FROM ovo_routing_member_claims
       WHERE organization_id = $1 AND pool_id = $2 AND ${ACTIVE} GROUP BY member_id`,
      [this.organizationId, poolId],
    );
    return Object.fromEntries(result.rows.map((row) => [row.member_id, Number(row.active)]));
  }

  /**
   * Members with room, least loaded first: by active/capacity (unlimited counts as 0), then by
   * active claims (so unlimited members still balance), then by member id.
   */
  private async ranked(
    client: PoolClient,
    tier: readonly RoutingMemberCandidate[],
  ): Promise<RoutingMemberCandidate[]> {
    const counts = await this.counts(client, tier);
    return tier
      .map((candidate, i) => ({ candidate, active: counts[i]! }))
      .filter(
        ({ candidate, active }) => candidate.capacity === undefined || active < candidate.capacity,
      )
      .sort(
        (a, b) =>
          load(a.candidate, a.active) - load(b.candidate, b.active) ||
          a.active - b.active ||
          a.candidate.memberId.localeCompare(b.candidate.memberId) ||
          a.candidate.poolId.localeCompare(b.candidate.poolId),
      )
      .map(({ candidate }) => candidate);
  }

  private async counts(
    client: PoolClient,
    candidates: readonly RoutingMemberCandidate[],
  ): Promise<number[]> {
    if (!candidates.length) return [];
    const result = await client.query<{ pool_id: string; member_id: string; active: number }>(
      `SELECT pool_id, member_id, count(*)::int AS active FROM ovo_routing_member_claims
       WHERE organization_id = $1 AND ${ACTIVE}
         AND (pool_id, member_id) IN (SELECT * FROM unnest($2::uuid[], $3::text[]))
       GROUP BY pool_id, member_id`,
      [this.organizationId, candidates.map((c) => c.poolId), candidates.map((c) => c.memberId)],
    );
    return candidates.map((c) => result.rows.find((row) => sameMember(c, row))?.active ?? 0);
  }
}

function sameMember(
  candidate: RoutingMemberCandidate,
  row: { pool_id: string; member_id: string },
): boolean {
  return candidate.poolId.toLowerCase() === row.pool_id && candidate.memberId === row.member_id;
}

function load(candidate: RoutingMemberCandidate, active: number): number {
  return candidate.capacity === undefined ? 0 : active / candidate.capacity;
}
