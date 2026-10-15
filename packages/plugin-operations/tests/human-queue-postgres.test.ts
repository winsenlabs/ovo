import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeHumanQueueService } from './human-queue/suite.ts';
import { ticketKit } from './human-queue/harness.ts';
import { humanQueueSchema, postgresHarness } from './human-queue/postgres-harness.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!postgresUrl)('human queues on PostgreSQL', () => {
  let db: Awaited<ReturnType<typeof humanQueueSchema>>;
  beforeAll(async () => {
    db = await humanQueueSchema(postgresUrl!);
  });
  afterAll(async () => db?.drop());

  describeHumanQueueService('the shared suite', async () => postgresHarness(db.pool));

  it('refuses an event the table would refuse as a RangeError, not a raw check error', async () => {
    const h = postgresHarness(db.pool);
    const { queueOf, open } = ticketKit(h);
    const ticket = await open(await queueOf());
    // 600 small elements: 1.2 KB of JSON text, but over 4 KiB once stored as jsonb.
    const payload = { digits: Array.from({ length: 600 }, (_, i) => i % 10) };
    expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeLessThan(4_096);
    await expect(
      h.service.tickets.appendEvent(ticket.id, { kind: 'dtmf', payload }),
    ).rejects.toThrow(RangeError);
  });
});
