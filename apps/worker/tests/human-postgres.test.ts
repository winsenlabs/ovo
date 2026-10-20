import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  PostgresHumanQueueService,
  runOperationsMigrations,
} from '@winsendotai/ovo-plugin-operations';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assertEventsValid,
  externalQueue,
  humanHarness,
  managedQueue,
  type HumanHarnessOptions,
} from './human-fixtures.ts';
import { holdPolicy, signal, transferPolicy } from './transfer-fixtures.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
// The worker does not depend on the driver; the operations package it composes does.
const { Pool } = createRequire(import.meta.resolve('@winsendotai/ovo-plugin-operations'))('pg') as {
  Pool: new (config: Record<string, unknown>) => {
    query(sql: string): Promise<unknown>;
    end(): Promise<void>;
  };
};

/**
 * The same handoffs as the in-memory tests, on the real PostgreSQL human queue service (operations
 * migration 013): the worker and the store agree on tickets, rooms, releases and the hand-off.
 */
describe.skipIf(!postgresUrl)('human queues on PostgreSQL', () => {
  const schema = `ovo_w17_worker_${randomUUID().replaceAll('-', '')}`;
  let pool: InstanceType<typeof Pool>;
  let admin: InstanceType<typeof Pool>;

  beforeAll(async () => {
    admin = new Pool({ connectionString: postgresUrl, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: postgresUrl,
      options: `-c search_path=${schema}`,
      max: 10,
    });
    await runOperationsMigrations(pool as never);
  });
  afterEach(assertEventsValid);
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });

  const onTimeout = [{ kind: 'default' as const }, { kind: 'end' as const, line: { en: 'Bye.' } }];
  const harness = (options: HumanHarnessOptions = {}) =>
    humanHarness({
      policy: transferPolicy({ hold: holdPolicy({ maxSeconds: 30, onTimeout }) }),
      workspaceId: `org-${randomUUID()}`,
      store: (workspace, now) =>
        new PostgresHumanQueueService(pool as never, workspace, { enabled: true, now }),
      ...options,
    });
  const request = (queueId: string) =>
    ({ kind: 'human', reason: 'route', queueId, variables: {} }) as const;

  /** Moves the fake clock on in 100 ms steps, giving the database real time to answer each. */
  async function tick(h: ReturnType<typeof harness>, ms: number) {
    for (let elapsed = 0; elapsed < ms; elapsed += 100) {
      await h.clock.advance(100);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }

  async function handOver(h: ReturnType<typeof harness>, queueId: string) {
    const router = await h.started();
    const begun = await h.controller.begin(request(queueId), signal());
    if (!begun.ok) throw new Error(begun.reason);
    h.controller.commit(begun.handoffId);
    await router.complete();
  }

  it('connects a managed queue: ticket, accept, operator in the room, the operator ends the call', async () => {
    const h = harness({ queues: [managedQueue()] });
    await handOver(h, 'desk');
    await vi.waitFor(() => expect(h.service.ids).toHaveLength(1));
    const id = h.service.id(1);
    expect(h.service.created[0]!.idempotencyKey).toMatch(/^hq:org-[0-9a-f-]+:job-1:1$/);
    expect((await h.service.ticket(id)).status).toBe('waiting');
    await h.service.accept(id, 'ana');
    await tick(h, 300);
    expect(h.rooms.seat().room).toBe(`ovo-hq-${id}`);
    h.rooms.seat().join('op:ana');
    await tick(h, 300);
    await vi.waitFor(() => expect(h.controller.attached?.role).toBe('human'));
    expect((await h.service.ticket(id)).connectedAt).toBeDefined();
    await h.service.command(id, { kind: 'end_call' });
    await tick(h, 500);
    await vi.waitFor(() => expect(h.link.closed).toEqual(['behavior_completed']));
    await h.controller.close('behavior_completed');
    const ended = await h.service.ticket(id);
    expect(ended).toMatchObject({ status: 'released', releaseCode: 'ended_by_operator' });
    expect(ended.outcome).toBe('ended');
    expect(h.rooms.deleted).toEqual([`ovo-hq-${id}`]);
  });

  it('re-offers a ticket whose operator never joins, and the next operator is connected', async () => {
    const h = harness({ queues: [managedQueue()] });
    await handOver(h, 'desk');
    await vi.waitFor(() => expect(h.service.ids).toHaveLength(1));
    const id = h.service.id(1);
    await h.service.accept(id, 'ana');
    await tick(h, 26_000);
    const waiting = await h.service.ticket(id);
    expect(waiting.status).toBe('waiting');
    await h.service.accept(id, 'bo');
    await tick(h, 300);
    h.rooms.seat().join('op:bo');
    await tick(h, 500);
    await vi.waitFor(() =>
      expect(h.controller.attached).toMatchObject({ role: 'human', operatorId: 'bo' }),
    );
  });

  it('hands a leg to a third party: the store releases it handed_off with the outcome', async () => {
    const third = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ status: 'accepted', destination: { e164: '+914012345678' } }),
          {
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
    const h = harness({
      queues: [externalQueue()],
      network: {
        lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
        fetch: third as unknown as typeof globalThis.fetch,
      },
      carrierHandoff: async () => ({ kind: 'confirmed' }),
    });
    await handOver(h, 'support-desk');
    await vi.waitFor(() => expect(h.link.closed).toEqual(['transferred']));
    const ticket = await h.service.ticket(h.service.id(1));
    expect(ticket).toMatchObject({
      status: 'released',
      releaseCode: 'handed_off',
      outcome: 'handed_off',
    });
    expect(ticket.connectedAt).toBeDefined();
  });

  it('times out an unanswered ticket into the chain and releases it', async () => {
    const h = harness({ queues: [managedQueue()] });
    await handOver(h, 'desk');
    await vi.waitFor(() => expect(h.service.ids).toHaveLength(1));
    await tick(h, 31_000);
    await vi.waitFor(() => expect(h.journal.entries).toContain('s2.start'));
    expect(await h.service.ticket(h.service.id(1))).toMatchObject({
      status: 'released',
      releaseCode: 'timed_out',
    });
  });
});
