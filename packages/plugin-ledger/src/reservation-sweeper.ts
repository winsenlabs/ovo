import type { Pool, PoolClient } from 'pg';
import { transaction } from './postgres/database.ts';
import { UsageRepository } from './postgres/usage.ts';

interface ExpiredReservation {
  id: string;
  budget_id: string;
  workspace_id: string;
  amount_paise: string;
  holder: string | null;
  expires_at: Date;
  session_id: string | null;
  carrier_provider: string | null;
  carrier_meter_key: string | null;
  carrier_price_card_id: string | null;
  carrier_price_card_version: string | null;
  carrier_fx_id: string | null;
  carrier_fx_version: string | null;
}

class IncompleteCarrierSnapshotError extends Error {
  constructor(readonly reservationId: string) {
    super(`Expired reservation ${reservationId} has no carrier price snapshot`);
  }
}

export interface ReservationJobPort {
  get(jobId: string): Promise<
    | {
        status: string;
        leaseExpiresAt?: Date;
        ownerId?: string;
      }
    | undefined
  >;
}

export class ReservationSweeper {
  private readonly usage: UsageRepository;

  constructor(
    private readonly pool: Pool,
    private readonly jobs: ReservationJobPort,
  ) {
    this.usage = new UsageRepository(pool);
  }

  async tick(signal: AbortSignal): Promise<number> {
    if (signal.aborted) return 0;
    return transaction(this.pool, async (client) => {
      const due = await client.query<ExpiredReservation>(
        `SELECT r.id,r.budget_id,b.workspace_id,r.amount_paise::text,r.holder,r.expires_at,
                r.session_id,r.carrier_provider,r.carrier_meter_key,r.carrier_price_card_id,
                r.carrier_price_card_version,r.carrier_fx_id,r.carrier_fx_version
         FROM ovo_cost_reservations r JOIN ovo_cost_budgets b ON b.id = r.budget_id
         WHERE r.state = 'reserved' AND r.expires_at < now()
         ORDER BY r.expires_at,r.id FOR UPDATE OF r SKIP LOCKED LIMIT 100`,
      );
      for (const row of due.rows) {
        if (signal.aborted) break;
        try {
          await this.resolve(client, row);
        } catch (error) {
          if (!(error instanceof IncompleteCarrierSnapshotError)) throw error;
          // Keep the reservation and budget fence intact, but let later rows through the
          // bounded batch while an operator repairs this manually corrupted snapshot.
          await client.query(
            `UPDATE ovo_cost_reservations SET expires_at = now() + interval '5 minutes'
             WHERE id = $1 AND state = 'reserved'`,
            [error.reservationId],
          );
          console.error(error.message);
        }
      }
      return due.rows.length;
    });
  }

  private async resolve(client: PoolClient, row: ExpiredReservation): Promise<void> {
    const divider = row.holder?.lastIndexOf(':') ?? -1;
    const workerId = divider > 0 ? row.holder!.slice(0, divider) : undefined;
    const jobId = divider > 0 ? row.holder!.slice(divider + 1) : undefined;
    const job = jobId ? await this.jobs.get(jobId) : undefined;
    if (
      job &&
      job.ownerId === workerId &&
      job.leaseExpiresAt &&
      job.leaseExpiresAt.getTime() > Date.now() &&
      !['completed', 'failed', 'cancelled'].includes(job.status)
    ) {
      await client.query(
        `UPDATE ovo_cost_reservations SET expires_at = now() + interval '5 minutes' WHERE id = $1`,
        [row.id],
      );
      await this.event(client, row, 'extended');
      return;
    }
    const route = row.session_id
      ? await client.query<{ connected_at: Date | null; terminal_at: Date }>(
          `SELECT connected_at,terminal_at FROM ovo_session_routes
           WHERE session_id::text = $1 AND organization_id = $2 AND terminal_at IS NOT NULL`,
          [row.session_id, row.workspace_id],
        )
      : undefined;
    if (route?.rows[0]) {
      await this.recordCarrier(client, row, jobId, route.rows[0]);
      const amount = await client.query<{ total: string }>(
        `WITH effective AS (
           SELECT c.amount_paise + COALESCE(SUM(x.delta_paise),0) AS amount
           FROM ovo_cost_native_usage u JOIN ovo_cost_charges c ON c.usage_id = u.id
           LEFT JOIN ovo_cost_corrections x ON x.usage_id = u.id
           WHERE u.workspace_id = $1 AND u.session_id = $2 GROUP BY c.id
         ) SELECT COALESCE(SUM(amount),0)::text AS total FROM effective`,
        [row.workspace_id, row.session_id],
      );
      await client.query('SELECT id FROM ovo_cost_budgets WHERE id = $1 FOR UPDATE', [
        row.budget_id,
      ]);
      await client.query(
        `UPDATE ovo_cost_reservations SET state = 'settled', actual_paise = $2, settled_at = now()
         WHERE id = $1 AND state = 'reserved'`,
        [row.id, amount.rows[0]!.total],
      );
      await client.query(
        `UPDATE ovo_cost_budgets SET spent_paise = spent_paise + $2,
           reserved_paise = reserved_paise - $3, updated_at = now() WHERE id = $1`,
        [row.budget_id, amount.rows[0]!.total, row.amount_paise],
      );
      await this.event(client, row, 'settled');
      return;
    }
    await client.query('SELECT id FROM ovo_cost_budgets WHERE id = $1 FOR UPDATE', [row.budget_id]);
    await client.query(
      `UPDATE ovo_cost_reservations SET state = 'released', settled_at = now()
       WHERE id = $1 AND state = 'reserved'`,
      [row.id],
    );
    await client.query(
      `UPDATE ovo_cost_budgets SET reserved_paise = reserved_paise - $2, updated_at = now()
       WHERE id = $1`,
      [row.budget_id, row.amount_paise],
    );
    await this.event(client, row, 'released');
  }

  private async recordCarrier(
    client: PoolClient,
    row: ExpiredReservation,
    jobId: string | undefined,
    route: { connected_at: Date | null; terminal_at: Date },
  ): Promise<void> {
    if (!route.connected_at || !row.session_id) return;
    if (
      !row.carrier_provider &&
      !row.carrier_meter_key &&
      !row.carrier_price_card_id &&
      !row.carrier_price_card_version
    )
      return;
    if (
      !row.carrier_provider ||
      !row.carrier_meter_key ||
      !row.carrier_price_card_id ||
      !row.carrier_price_card_version
    )
      throw new IncompleteCarrierSnapshotError(row.id);
    const sourceEventId = `carrier-total:${jobId ?? row.session_id}`;
    const existing = await client.query(
      `SELECT 1 FROM ovo_cost_native_usage WHERE workspace_id = $1 AND session_id = $2
         AND source_event_type = 'carrier.elapsed.estimated' AND source_event_id = $3`,
      [row.workspace_id, row.session_id, `${row.session_id}:${sourceEventId}`],
    );
    if (existing.rowCount) return;
    const elapsedMs = Math.max(1, route.terminal_at.getTime() - route.connected_at.getTime());
    const seconds = (elapsedMs / 1000)
      .toFixed(3)
      .replace(/\.0+$/, '')
      .replace(/(\.\d*?)0+$/, '$1');
    await this.usage.recordWithClient(client, {
      idempotencyKey: `usage:${row.session_id}:carrier:${sourceEventId}:audio_seconds`,
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
      callId: jobId,
      provider: row.carrier_provider,
      sourceKind: 'carrier',
      sourceEventType: 'carrier.elapsed.estimated',
      sourceEventId: `${row.session_id}:${sourceEventId}`,
      activity: 'normal',
      cacheDisposition: 'none',
      quantity: seconds,
      unit: 'audio_seconds',
      occurredAt: route.terminal_at.toISOString(),
      priceCard: { id: row.carrier_price_card_id, version: row.carrier_price_card_version },
      ...(row.carrier_fx_id && row.carrier_fx_version
        ? { fx: { id: row.carrier_fx_id, version: row.carrier_fx_version } }
        : {}),
    });
  }

  private async event(client: PoolClient, row: ExpiredReservation, outcome: string): Promise<void> {
    await client.query(
      `INSERT INTO ovo_cost_reservation_events
         (reservation_id,event_type,observed_expiry,outcome)
       VALUES ($1,'reservation.expired',$2,$3)
       ON CONFLICT (reservation_id,event_type,observed_expiry) DO NOTHING`,
      [row.id, row.expires_at, outcome],
    );
  }
}
