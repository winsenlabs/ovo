import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RoutingPointDraft } from '@winsendotai/ovo-contracts';
import { PostgresOperationsService, runOperationsMigrations } from '../src/index.ts';
import { PostgresHumanQueueService } from '../src/human-queue/postgres/service.ts';
import { HumanQueueNameTakenError } from '../src/human-queue/service.ts';
import { HqConflictError } from '../src/human-queue/store.ts';
import { PgHqStore } from '../src/human-queue/postgres/store.ts';
import m001 from '../migrations/001_operations.sql?raw';
import m002 from '../migrations/002_live_launch.sql?raw';
import m003 from '../migrations/003_inbound_gateway.sql?raw';
import m004 from '../migrations/004_inbound_overflow.sql?raw';
import m005 from '../migrations/005_inbound_carrier.sql?raw';
import m006 from '../migrations/006_inbound_admission_carrier.sql?raw';
import m007 from '../migrations/007_campaign_pacing.sql?raw';
import m008 from '../migrations/008_outbound_compliance.sql?raw';
import m009 from '../migrations/009_india_compliance.sql?raw';
import m010 from '../migrations/010_routing.sql?raw';
import m011 from '../migrations/011_routing_transfer.sql?raw';
import m012 from '../migrations/012_inbound_default_variables.sql?raw';
import { routingSchema, salesDraft, salesPool, releaseIds } from './routing-fixture.ts';
import {
  managedDefinition,
  externalDefinition,
  ticketFor,
  T0,
  profile,
} from './human-queue/harness.ts';
import { humanQueueSchema } from './human-queue/postgres-harness.ts';
import { MemoryClock } from '../src/human-queue/memory-support.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!postgresUrl)('operations migration 013 (human queues)', () => {
  let db: Awaited<ReturnType<typeof routingSchema>>;

  beforeAll(async () => {
    db = await routingSchema(postgresUrl!);
    // A database exactly as Wave 16 left it: 001-012 applied.
    await db.pool.query(
      'CREATE TABLE ovo_ops_schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const older = [m001, m002, m003, m004, m005, m006, m007, m008, m009, m010, m011, m012];
    for (const [index, sql] of older.entries()) {
      await db.pool.query(sql);
      await db.pool.query('INSERT INTO ovo_ops_schema_migrations (version) VALUES ($1)', [
        index + 1,
      ]);
    }
  });
  afterAll(async () => db?.drop());

  it('applies over 012 data, creates the five tables and reruns as a no-op', async () => {
    const before = await db.pool.query(`SELECT count(*)::int AS n FROM ovo_routing_points`);
    await runOperationsMigrations(db.pool);
    await runOperationsMigrations(db.pool);
    const versions = await db.pool.query<{ version: number }>(
      'SELECT version FROM ovo_ops_schema_migrations ORDER BY version',
    );
    expect(versions.rows.map((row) => row.version).at(-1)).toBe(13);
    const tables = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name LIKE 'ovo\\_hq\\_%' ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'ovo_hq_operators',
      'ovo_hq_point_queues',
      'ovo_hq_queues',
      'ovo_hq_ticket_events',
      'ovo_hq_tickets',
    ]);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM ovo_routing_points`)).rows).toEqual(
      before.rows,
    );
    // The SQL itself is idempotent too: a half-applied run re-executes it whole.
    const sql = (await import('../migrations/013_human_queues.sql?raw')).default;
    await db.pool.query(sql);
  });

  it('enforces its checks and the one-active-ticket-per-call index in the database', async () => {
    const insert = (over: Record<string, unknown> = {}) => {
      const row = {
        id: randomUUID(),
        call_id: 'call-1',
        idempotency_key: randomUUID(),
        queue_id: randomUUID(),
        status: 'waiting',
        ...over,
      };
      return db.pool.query(
        `INSERT INTO ovo_hq_tickets (organization_id, id, call_id, idempotency_key, queue_id, queue_key,
           queue_name, kind, mode, status, expires_at)
         VALUES ('org-x', $1, $2, $3, $4, 'q', 'Q', 'managed', 'OPEN_PICKUP', $5, now())`,
        [row.id, row.call_id, row.idempotency_key, row.queue_id, row.status],
      );
    };
    await insert();
    await expect(insert()).rejects.toThrow(/ovo_hq_tickets_active_call_idx/);
    await insert({ call_id: 'call-ended', status: 'released' });
    await insert({ call_id: 'call-ended', status: 'expired' });
    await expect(insert({ call_id: 'call-2', status: 'open' })).rejects.toThrow(/check/i);
    await expect(
      db.pool.query(
        `INSERT INTO ovo_hq_operators (organization_id, user_id, capacity) VALUES ('org-x', 'u', 21)`,
      ),
    ).rejects.toThrow(/check/i);
    await expect(
      db.pool.query(
        `INSERT INTO ovo_hq_operators (organization_id, user_id, status) VALUES ('org-x', 'u', 'BUSY')`,
      ),
    ).rejects.toThrow(/check/i);
    await expect(
      db.pool.query(
        `INSERT INTO ovo_hq_queues (organization_id, id, name, kind, definition)
         VALUES ('org-x', $1, 'Q', 'managed', '[]'::jsonb)`,
        [randomUUID()],
      ),
    ).rejects.toThrow(/check/i);
  });
});

describe.skipIf(!postgresUrl)('human queues on PostgreSQL: rules only a database can break', () => {
  let db: Awaited<ReturnType<typeof humanQueueSchema>>;
  let org = '';
  let clock: MemoryClock;
  let service: PostgresHumanQueueService;

  beforeAll(async () => {
    db = await humanQueueSchema(postgresUrl!);
  });
  afterAll(async () => db?.drop());

  const fresh = () => {
    org = `org-${randomUUID()}`;
    clock = new MemoryClock(T0);
    service = new PostgresHumanQueueService(db.pool, org, { enabled: true, now: clock.now });
  };

  async function open(patch = {}) {
    const queue = await service.queues.create(managedDefinition());
    const ticket = await service.tickets.create(ticketFor(queue, patch));
    if (ticket === 'queue_full') throw new Error('queue_full');
    return { queue, ticket };
  }

  it('keeps point links in step with drafts and guards queue delete', async () => {
    fresh();
    const operations = new PostgresOperationsService({
      pool: db.pool,
      organizationId: org,
      config: { permittedFromNumbers: [], routingEnabled: true, humanQueueEnabled: true },
    });
    const queue = await operations.humanQueues.queues.create(managedDefinition());
    const other = await operations.humanQueues.queues.create(managedDefinition());
    const ids = releaseIds();
    const pool = await operations.routing.pools.create(salesPool(ids));
    const draft = (queues: string[]) =>
      RoutingPointDraft.parse({
        ...salesDraft(pool.id),
        humanQueues: queues.map((queueId, i) => ({ key: `q${i}`, queueId })),
      });
    const point = await operations.routing.points.create(draft([queue.id]));
    expect(await operations.humanQueues.queues.usedBy(queue.id)).toEqual([point.id]);
    expect(await operations.humanQueues.queues.usedBy(other.id)).toEqual([]);
    expect(await operations.humanQueues.queues.remove(queue.id, 1)).toEqual({
      inUseBy: [point.id],
    });

    const moved = await operations.routing.points.update(point.id, draft([other.id]), 1);
    expect(moved?.draftVersion).toBe(2);
    expect(await operations.humanQueues.queues.usedBy(queue.id)).toEqual([]);
    expect(await operations.humanQueues.queues.usedBy(other.id)).toEqual([point.id]);
    expect(await operations.humanQueues.queues.remove(queue.id, 1)).toBe('removed');
    expect(await operations.humanQueues.queues.remove(other.id, 1)).toEqual({
      inUseBy: [point.id],
    });

    expect(await operations.routing.points.remove(point.id, 2)).toBe('removed');
    expect(await operations.humanQueues.queues.usedBy(other.id)).toEqual([]);
    expect(await operations.humanQueues.queues.remove(other.id, 1)).toBe('removed');
    // A deleted queue is still readable for a release that pinned it.
    expect(
      await operations.humanQueues.queues.get(queue.id, { includeDeleted: true }),
    ).toMatchObject({
      id: queue.id,
    });
  });

  it('is off by default and reports the flag and the presence TTL', async () => {
    fresh();
    const off = new PostgresOperationsService({ pool: db.pool, organizationId: org });
    expect(off.humanQueues.enabled).toBe(false);
    expect(off.config.humanQueueEnabled).toBe(false);
    const on = new PostgresOperationsService({
      pool: db.pool,
      organizationId: org,
      config: {
        permittedFromNumbers: [],
        humanQueueEnabled: true,
        humanQueuePresenceTtlSeconds: 5,
      },
    });
    expect(on.humanQueues.enabled).toBe(true);
    await on.humanQueues.operators.upsert(profile('asha'));
    await on.humanQueues.operators.heartbeat('asha', 'AVAILABLE');
    expect((await on.humanQueues.operators.list())[0]!.status).toBe('AVAILABLE');
    await new Promise((resolve) => setTimeout(resolve, 5_300));
    expect((await on.humanQueues.operators.list())[0]!.status).toBe('OFFLINE');
  }, 15_000);

  it('opens one ticket when many creates race on one idempotency key', async () => {
    fresh();
    const queue = await service.queues.create(managedDefinition());
    const input = ticketFor(queue);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => service.tickets.create(input)),
    );
    const tickets = results.filter((r) => r !== 'queue_full');
    expect(new Set(tickets.map((t) => t.id)).size).toBe(1);
    expect(tickets.filter((t) => !t.duplicate)).toHaveLength(1);
    const rows = await db.pool.query(
      'SELECT count(*)::int AS n FROM ovo_hq_tickets WHERE organization_id = $1',
      [org],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('leaves exactly one active ticket when creates for one call race', async () => {
    fresh();
    const queue = await service.queues.create(managedDefinition());
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        service.tickets.create(
          ticketFor(queue, { callId: 'call-race', idempotencyKey: `hq:race:${i}` }),
        ),
      ),
    );
    const rows = await db.pool.query(
      `SELECT status, count(*)::int AS n FROM ovo_hq_tickets WHERE organization_id = $1 GROUP BY status`,
      [org],
    );
    const byStatus = Object.fromEntries(rows.rows.map((r) => [r.status, r.n]));
    expect(byStatus.waiting).toBe(1);
    expect(byStatus.released).toBe(7);
  });

  it('refuses an event the table would refuse as a RangeError, not a raw check error', async () => {
    fresh();
    const { ticket } = await open({ callId: 'call-big-event' });
    // 600 small elements: 1.2 KB of JSON text, but over 4 KiB once stored as jsonb.
    const payload = { digits: Array.from({ length: 600 }, (_, i) => i % 10) };
    expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeLessThan(4_096);
    await expect(service.tickets.appendEvent(ticket.id, { kind: 'dtmf', payload })).rejects.toThrow(
      RangeError,
    );
  });

  it('rolls a failed unit back whole', async () => {
    fresh();
    const { queue, ticket } = await open({ callId: 'call-rb' });
    const store = new PgHqStore(db.pool, org, clock.now);
    await expect(
      store.run(async (tx) => {
        await tx.updateTicket(ticket.id, { status: 'released', version: 2 });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await service.tickets.get(ticket.id)).toMatchObject({ status: 'waiting', version: 1 });
    await expect(
      store.run(async (tx) => {
        await tx.insertTicket({
          ...(await tx.ticket(ticket.id))!,
          id: randomUUID(),
          idempotencyKey: 'another',
        } as never);
      }),
    ).rejects.toBeInstanceOf(HqConflictError);
    expect(queue.id).toBeTruthy();
  });

  it("serialises one operator's accepts across connections", async () => {
    fresh();
    const queue = await service.queues.create(managedDefinition());
    await service.operators.upsert(profile('asha', { capacity: 3 }));
    await service.operators.heartbeat('asha', 'AVAILABLE');
    const tickets = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const t = await service.tickets.create(ticketFor(queue));
        if (t === 'queue_full') throw new Error('full');
        return t;
      }),
    );
    // Separate services on separate pools, as separate API processes would be.
    const pools = Array.from(
      { length: 4 },
      () =>
        new Pool({
          connectionString: postgresUrl!,
          options: (db.pool as unknown as { options: { options?: string } }).options.options,
          max: 4,
        }),
    );
    try {
      const services = pools.map(
        (p) => new PostgresHumanQueueService(p, org, { enabled: true, now: clock.now }),
      );
      const results = await Promise.all(
        tickets.map((t, i) =>
          services[i % services.length]!.tickets.accept({
            workspaceId: org,
            ticketId: t.id,
            operatorId: 'asha',
            expectedVersion: t.version,
            idempotencyKey: `k${i}`,
          }),
        ),
      );
      expect(results.filter((r) => 'status' in r)).toHaveLength(3);
      expect(results.filter((r) => 'kind' in r && r.kind === 'at_capacity')).toHaveLength(7);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });

  it('lets one of two sweepers sweep and the other do nothing (single flight)', async () => {
    fresh();
    await open();
    clock.advance(600_000);
    const holder = await db.pool.connect();
    try {
      await holder.query('BEGIN');
      const store = new PgHqStore(db.pool, org, clock.now);
      // Another session holds the sweep lock: the same lock key the sweeper takes.
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        `ovo-hq-single-flight:${org}`,
        'ovo-human-queue-sweep',
      ]);
      expect(await service.sweep(clock.now())).toEqual({
        assigned: 0,
        expired: 0,
        reoffered: 0,
        scrubbed: 0,
        stale: 0,
      });
      expect(store).toBeTruthy();
      await holder.query('COMMIT');
    } finally {
      holder.release();
    }
    // With the lock free the same pass finds the work (the ticket's worker stopped beating too).
    const result = await service.sweep(clock.now());
    expect(result.stale + result.expired).toBe(1);
  });

  it('skips a ticket another unit is changing and takes it on the next pass', async () => {
    fresh();
    const { ticket } = await open();
    clock.advance(200_000);
    await service.tickets.workerBeat(ticket.id);
    const holder = await db.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT 1 FROM ovo_hq_tickets WHERE organization_id = $1 AND id = $2 FOR UPDATE',
        [org, ticket.id],
      );
      expect((await service.sweep(clock.now())).expired).toBe(0);
      await holder.query('COMMIT');
    } finally {
      holder.release();
    }
    expect((await service.sweep(clock.now())).expired).toBe(1);
  });

  it('nulls every sensitive column when a context is scrubbed, and keeps the rows', async () => {
    fresh();
    const queue = await service.queues.create(externalDefinition());
    const input = ticketFor(queue, { contextRetentionHours: 1 });
    const ticket = (await service.tickets.create(input)) as { id: string };
    await service.tickets.issueContextToken(ticket.id, 900);
    await service.tickets.markHandedOff(ticket.id);
    const sensitive = () =>
      db.pool.query(
        `SELECT context IS NOT NULL AS context, caller_masked IS NOT NULL AS masked,
                context_token_hash IS NOT NULL AS token, command IS NOT NULL AS command,
                context_expires_at FROM ovo_hq_tickets WHERE organization_id = $1 AND id = $2`,
        [org, ticket.id],
      );
    expect((await sensitive()).rows[0]).toMatchObject({ context: true, masked: true, token: true });
    clock.advance(3_600_000);
    expect((await service.sweep(clock.now())).scrubbed).toBe(1);
    expect((await sensitive()).rows[0]).toMatchObject({
      context: false,
      masked: false,
      token: false,
      command: false,
    });
    const kept = await db.pool.query(
      'SELECT status, release_code FROM ovo_hq_tickets WHERE organization_id = $1 AND id = $2',
      [org, ticket.id],
    );
    expect(kept.rows[0]).toEqual({ status: 'released', release_code: 'handed_off' });
    const events = await db.pool.query(
      'SELECT count(*)::int AS n FROM ovo_hq_ticket_events WHERE organization_id = $1 AND ticket_id = $2',
      [org, ticket.id],
    );
    expect(events.rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it("keeps tickets of one organization out of another's views", async () => {
    fresh();
    const mine = service;
    const { ticket } = await open();
    const stranger = new PostgresHumanQueueService(db.pool, `org-${randomUUID()}`, {
      enabled: true,
      now: clock.now,
    });
    expect(await stranger.tickets.get(ticket.id)).toBeUndefined();
    expect(await stranger.queues.list(100)).toEqual([]);
    expect(
      await stranger.tickets.accept({
        workspaceId: org,
        ticketId: ticket.id,
        operatorId: 'x',
        expectedVersion: 1,
        idempotencyKey: 'k',
      }),
    ).toEqual({ kind: 'conflict' });
    expect(await mine.tickets.get(ticket.id)).toBeDefined();
    // The same queue name is free in another organization.
    await stranger.queues.create(managedDefinition({ name: 'Same name' }));
    await mine.queues.create(managedDefinition({ name: 'Same name' }));
    await expect(mine.queues.create(managedDefinition({ name: 'same NAME' }))).rejects.toThrow(
      HumanQueueNameTakenError,
    );
  });
});
