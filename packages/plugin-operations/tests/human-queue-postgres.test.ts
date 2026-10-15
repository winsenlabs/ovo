import { afterAll, beforeAll, describe } from 'vitest';
import { describeHumanQueueService } from './human-queue/suite.ts';
import { humanQueueSchema, postgresHarness } from './human-queue/postgres-harness.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!postgresUrl)('human queues on PostgreSQL', () => {
  let db: Awaited<ReturnType<typeof humanQueueSchema>>;
  beforeAll(async () => {
    db = await humanQueueSchema(postgresUrl!);
  });
  afterAll(async () => db?.drop());

  describeHumanQueueService('the shared suite', async () => postgresHarness(db.pool));
});
