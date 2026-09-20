import type { Pool } from 'pg';

export class CapacityLeaseRepository {
  constructor(private readonly pool: Pool) {}

  async acquire(
    serviceKey: string,
    authorityId: string,
    leaseMs: number,
  ): Promise<{ epoch: number } | undefined> {
    const result = await this.pool.query<{ epoch: string }>(
      `INSERT INTO ovo_capacity_leases (service_key, authority_id, epoch, lease_expires_at)
       VALUES ($1, $2, 1, now() + ($3 * interval '1 millisecond'))
       ON CONFLICT (service_key) DO UPDATE SET
         authority_id = EXCLUDED.authority_id,
         epoch = CASE WHEN ovo_capacity_leases.authority_id = EXCLUDED.authority_id
                      THEN ovo_capacity_leases.epoch ELSE ovo_capacity_leases.epoch + 1 END,
         lease_expires_at = EXCLUDED.lease_expires_at, updated_at = now()
       WHERE ovo_capacity_leases.lease_expires_at < now() OR ovo_capacity_leases.authority_id = EXCLUDED.authority_id
       RETURNING epoch`,
      [serviceKey, authorityId, leaseMs],
    );
    return result.rows[0] ? { epoch: Number(result.rows[0].epoch) } : undefined;
  }

  async renew(
    serviceKey: string,
    authorityId: string,
    epoch: number,
    leaseMs: number,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ovo_capacity_leases SET lease_expires_at = now() + ($4 * interval '1 millisecond'), updated_at = now()
       WHERE service_key = $1 AND authority_id = $2 AND epoch = $3 AND lease_expires_at > now()`,
      [serviceKey, authorityId, epoch, leaseMs],
    );
    return result.rowCount === 1;
  }
}
