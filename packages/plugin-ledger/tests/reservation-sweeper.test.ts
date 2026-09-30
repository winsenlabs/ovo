import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresCostLedger } from '../src/postgres.ts';
import { ReservationSweeper, type ReservationJobPort } from '../src/reservation-sweeper.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!postgresUrl)('durable reservation expiry on Postgres', () => {
  const schema = `cost_expiry_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let pool: Pool;
  let ledger: PostgresCostLedger;
  const jobs = new Map<string, Awaited<ReturnType<ReservationJobPort['get']>>>();
  const jobPort: ReservationJobPort = { get: async (id) => jobs.get(id) };

  beforeAll(async () => {
    admin = new Pool({ connectionString: postgresUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: postgresUrl, options: `-c search_path=${schema}` });
    ledger = new PostgresCostLedger(pool);
    await ledger.migrate();
    await pool.query(`CREATE TABLE ovo_session_routes (
      session_id uuid PRIMARY KEY, organization_id text NOT NULL,
      connected_at timestamptz, terminal_at timestamptz)`);
    await ledger.putPriceCard({
      id: 'plivo-carrier',
      version: 'v1',
      provider: 'plivo',
      unit: 'audio_seconds',
      currency: 'INR',
      minorUnitsPerBlock: '2',
      blockQuantity: '1',
      effectiveAt: '2026-01-01T00:00:00.000Z',
      provenance: 'test fixture',
    });
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });

  async function reservation(jobId = randomUUID(), withCarrier = true) {
    const workspaceId = `org-${randomUUID()}`;
    const budgetId = randomUUID();
    const sessionId = randomUUID();
    const holder = `worker-A:${jobId}`;
    await ledger.createBudget({
      id: budgetId,
      workspaceId,
      limitPaise: '1000',
      admissionOverspendPaise: '0',
    });
    const input = {
      budgetId,
      reservationId: sessionId,
      amountPaise: '100',
      sourceRef: `job:${jobId}`,
      holder,
      expiresAt: new Date(Date.now() - 1000),
      sessionId,
      ...(withCarrier
        ? {
            carrierUsage: {
              meterKey: 'plivo.carrier.audio_seconds',
              provider: 'plivo',
              priceCard: { id: 'plivo-carrier', version: 'v1' },
            },
          }
        : {}),
    };
    expect((await ledger.reserveBudget(input)).admitted).toBe(true);
    return { ...input, workspaceId, jobId };
  }

  it('releases an expired reservation when the job lease belongs to another worker', async () => {
    const row = await reservation();
    jobs.set(row.jobId, {
      status: 'running',
      ownerId: 'worker-B',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    expect(await new ReservationSweeper(pool, jobPort).tick(new AbortController().signal)).toBe(1);
    expect(
      (await pool.query('SELECT state FROM ovo_cost_reservations WHERE id=$1', [row.sessionId]))
        .rows[0],
    ).toEqual({ state: 'released' });
    const { workspaceId: _workspaceId, jobId: _jobId, ...sameReservation } = row;
    expect(await ledger.reserveBudget(sameReservation)).toMatchObject({
      admitted: false,
      reason: 'reservation-not-active',
    });
    expect(
      (
        await pool.query(
          'SELECT outcome FROM ovo_cost_reservation_events WHERE reservation_id=$1',
          [row.sessionId],
        )
      ).rows,
    ).toEqual([{ outcome: 'released' }]);
  });

  it('extends an expired reservation when the sweeper sees a live lease for its holder', async () => {
    const row = await reservation();
    jobs.set(row.jobId, {
      status: 'running',
      ownerId: 'worker-A',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    expect(await new ReservationSweeper(pool, jobPort).tick(new AbortController().signal)).toBe(1);
    const state = (
      await pool.query('SELECT state,expires_at FROM ovo_cost_reservations WHERE id=$1', [
        row.sessionId,
      ])
    ).rows[0];
    expect(state.state).toBe('reserved');
    expect(state.expires_at.getTime()).toBeGreaterThan(Date.now());
    expect(
      (
        await pool.query(
          'SELECT outcome FROM ovo_cost_reservation_events WHERE reservation_id=$1',
          [row.sessionId],
        )
      ).rows,
    ).toEqual([{ outcome: 'extended' }]);
  });

  it('records priced non-Twilio elapsed carrier usage and settles a terminal session once', async () => {
    const row = await reservation();
    jobs.set(row.jobId, { status: 'completed', ownerId: 'worker-A' });
    const connected = new Date(Date.now() - 12_000);
    const terminal = new Date(connected.getTime() + 10_000);
    await pool.query(
      'INSERT INTO ovo_session_routes(session_id,organization_id,connected_at,terminal_at) VALUES($1,$2,$3,$4)',
      [row.sessionId, row.workspaceId, connected, terminal],
    );
    const sweeper = new ReservationSweeper(pool, jobPort);
    expect(await sweeper.tick(new AbortController().signal)).toBe(1);
    expect(await sweeper.tick(new AbortController().signal)).toBe(0);
    expect(
      (
        await pool.query('SELECT state,actual_paise::text FROM ovo_cost_reservations WHERE id=$1', [
          row.sessionId,
        ])
      ).rows[0],
    ).toEqual({ state: 'settled', actual_paise: '20' });
    expect(await ledger.getBudget(row.budgetId)).toMatchObject({
      spentPaise: '20',
      reservedPaise: '0',
    });
    expect(
      (
        await pool.query(
          'SELECT provider,source_event_id,quantity FROM ovo_cost_native_usage WHERE session_id=$1',
          [row.sessionId],
        )
      ).rows,
    ).toEqual([
      {
        provider: 'plivo',
        source_event_id: `${row.sessionId}:carrier-total:${row.jobId}`,
        quantity: '10',
      },
    ]);
    expect(
      (
        await pool.query(
          'SELECT outcome FROM ovo_cost_reservation_events WHERE reservation_id=$1',
          [row.sessionId],
        )
      ).rows,
    ).toEqual([{ outcome: 'settled' }]);
  });

  it('keeps the reserved-state fence on settlement when a row changes during resolution', async () => {
    const row = await reservation(randomUUID(), false);
    jobs.set(row.jobId, { status: 'completed', ownerId: 'worker-A' });
    const connected = new Date(Date.now() - 12_000);
    await pool.query(
      'INSERT INTO ovo_session_routes(session_id,organization_id,connected_at,terminal_at) VALUES($1,$2,$3,$4)',
      [row.sessionId, row.workspaceId, connected, new Date()],
    );
    let injected = false;
    const interceptingPool = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, params?: unknown[]) => {
            if (!injected && sql.includes("SET state = 'settled'")) {
              injected = true;
              await client.query("UPDATE ovo_cost_reservations SET state='released' WHERE id=$1", [
                params?.[0],
              ]);
            }
            return client.query(sql, params);
          },
          release: () => client.release(),
        };
      },
    } as unknown as Pool;
    expect(
      await new ReservationSweeper(interceptingPool, jobPort).tick(new AbortController().signal),
    ).toBe(1);
    expect(injected).toBe(true);
    expect(
      (await pool.query('SELECT state FROM ovo_cost_reservations WHERE id=$1', [row.sessionId]))
        .rows[0],
    ).toEqual({ state: 'released' });
  });

  it('does not double-charge a carrier elapsed event already written by normal finalization', async () => {
    const row = await reservation();
    jobs.set(row.jobId, { status: 'completed', ownerId: 'worker-A' });
    const connected = new Date(Date.now() - 12_000);
    const terminal = new Date(connected.getTime() + 10_000);
    await pool.query(
      'INSERT INTO ovo_session_routes(session_id,organization_id,connected_at,terminal_at) VALUES($1,$2,$3,$4)',
      [row.sessionId, row.workspaceId, connected, terminal],
    );
    const sourceEventId = `carrier-total:${row.jobId}`;
    await ledger.recordUsage({
      idempotencyKey: `usage:${row.sessionId}:carrier:${sourceEventId}:audio_seconds`,
      workspaceId: row.workspaceId,
      sessionId: row.sessionId,
      callId: row.jobId,
      provider: 'plivo',
      sourceKind: 'carrier',
      sourceEventType: 'carrier.elapsed.estimated',
      sourceEventId: `${row.sessionId}:${sourceEventId}`,
      activity: 'normal',
      cacheDisposition: 'none',
      quantity: '9',
      unit: 'audio_seconds',
      occurredAt: terminal.toISOString(),
      priceCard: { id: 'plivo-carrier', version: 'v1' },
    });
    expect(await new ReservationSweeper(pool, jobPort).tick(new AbortController().signal)).toBe(1);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM ovo_cost_native_usage WHERE session_id=$1',
          [row.sessionId],
        )
      ).rows[0]?.n,
    ).toBe(1);
    expect(await ledger.getBudget(row.budgetId)).toMatchObject({
      spentPaise: '18',
      reservedPaise: '0',
    });
  });

  it('settles a terminal selection without a carrier meter snapshot without inventing usage', async () => {
    const row = await reservation(randomUUID(), false);
    jobs.set(row.jobId, { status: 'completed', ownerId: 'worker-A' });
    const connected = new Date(Date.now() - 12_000);
    await pool.query(
      'INSERT INTO ovo_session_routes(session_id,organization_id,connected_at,terminal_at) VALUES($1,$2,$3,$4)',
      [row.sessionId, row.workspaceId, connected, new Date()],
    );
    expect(await new ReservationSweeper(pool, jobPort).tick(new AbortController().signal)).toBe(1);
    expect(
      (
        await pool.query('SELECT state,actual_paise::text FROM ovo_cost_reservations WHERE id=$1', [
          row.sessionId,
        ])
      ).rows[0],
    ).toEqual({ state: 'settled', actual_paise: '0' });
    expect(await ledger.getBudget(row.budgetId)).toMatchObject({
      spentPaise: '0',
      reservedPaise: '0',
    });
  });

  it('refuses a partial carrier snapshot and leaves the reservation recoverable', async () => {
    const row = await reservation();
    jobs.set(row.jobId, { status: 'completed', ownerId: 'worker-A' });
    await pool.query('UPDATE ovo_cost_reservations SET carrier_meter_key = NULL WHERE id = $1', [
      row.sessionId,
    ]);
    const connected = new Date(Date.now() - 12_000);
    await pool.query(
      'INSERT INTO ovo_session_routes(session_id,organization_id,connected_at,terminal_at) VALUES($1,$2,$3,$4)',
      [row.sessionId, row.workspaceId, connected, new Date()],
    );
    await expect(
      new ReservationSweeper(pool, jobPort).tick(new AbortController().signal),
    ).rejects.toThrow(`Expired reservation ${row.sessionId} has no carrier price snapshot`);
    expect(
      (await pool.query('SELECT state FROM ovo_cost_reservations WHERE id = $1', [row.sessionId]))
        .rows[0],
    ).toEqual({ state: 'reserved' });
  });
});
