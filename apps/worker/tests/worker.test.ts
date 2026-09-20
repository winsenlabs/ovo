import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WorkerRunner } from '../src/index.ts';
import { PostgresOrchestrationStore } from '@winsendotai/ovo-plugin-orchestration';
import type {
  ClaimedJob,
  DialReconciliation,
  DialResult,
  DurableJob,
  DurableJobStore,
  DurableQueue,
  JobClaimResult,
  QueueDelivery,
  TaskProtection,
  TelephonyControl,
  TelephonyDialRequest,
} from '@winsendotai/ovo-plugin-orchestration';

const delivery: QueueDelivery = {
  messageId: 'message-1',
  receiptHandle: 'receipt-1',
  receiveCount: 1,
  reference: { schemaVersion: 1, jobId: '00000000-0000-4000-8000-000000000001' },
};

class MemoryStore implements DurableJobStore {
  state: DurableJob['status'] = 'queued';
  dialRequestId?: string;
  carrierCallId?: string;
  claims = 0;
  claimMode: 'execute' | 'reconcile' | 'defer' = 'execute';
  deferReason: 'currently_leased' | 'not_before' = 'currently_leased';

  async enqueue(): Promise<{ job: DurableJob; created: boolean }> {
    throw new Error('not used');
  }
  async claim(jobId: string, workerId: string): Promise<JobClaimResult> {
    if (this.claimMode === 'defer') {
      return { kind: 'defer', reason: this.deferReason, retryAt: new Date(Date.now() + 5_000) };
    }
    if (this.claimMode === 'execute' && this.state !== 'queued') return { kind: 'settled' };
    this.claims += 1;
    this.state = this.claimMode === 'reconcile' ? 'reconcile_required' : 'owned';
    const job: ClaimedJob = {
      id: jobId,
      workspaceId: 'ws-1',
      idempotencyKey: 'key-1',
      status: this.state,
      ownerId: workerId,
      ownerEpoch: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      payload: {
        to: '+910000000001',
        from: '+910000000002',
        streamUrl: 'wss://example.test/media',
        statusCallbackUrl: 'https://example.test/status',
      },
    };
    if (this.claimMode === 'reconcile') job.dialRequestId = `${jobId}:1`;
    return { kind: this.claimMode, job };
  }
  async heartbeat(): Promise<boolean> {
    return true;
  }
  async release(): Promise<boolean> {
    this.state = 'queued';
    return true;
  }
  async beginDial(
    _jobId: string,
    _workerId: string,
    _epoch: number,
    requestId: string,
  ): Promise<boolean> {
    if (this.state !== 'owned') return false;
    this.state = 'dialing';
    this.dialRequestId = requestId;
    return true;
  }
  async markDialAccepted(
    _jobId: string,
    _workerId: string,
    _epoch: number,
    _requestId: string,
    callId: string,
  ): Promise<boolean> {
    this.state = 'accepted';
    this.carrierCallId = callId;
    return true;
  }
  async markDialUnknown(): Promise<boolean> {
    this.state = 'reconcile_required';
    return true;
  }
  async deferReconciliation(): Promise<boolean> {
    this.state = 'reconcile_required';
    return true;
  }
  async markFailed(): Promise<boolean> {
    this.state = 'failed';
    return true;
  }
  async get(): Promise<DurableJob | undefined> {
    return undefined;
  }
}

class MemoryQueue implements DurableQueue {
  deleted = 0;
  visibilityChanges = 0;
  async send() {
    return { messageId: 'sent' };
  }
  async receive() {
    return [];
  }
  async delete() {
    this.deleted += 1;
  }
  async changeVisibility() {
    this.visibilityChanges += 1;
  }
}

class FakeProtection implements TaskProtection {
  releases = 0;
  constructor(private readonly allowed: boolean) {}
  async establish() {
    return this.allowed;
  }
  async renew() {
    return this.allowed;
  }
  async release() {
    this.releases += 1;
  }
}

class FakeTelephony implements TelephonyControl {
  dials = 0;
  reconciliations = 0;
  constructor(
    private readonly dialResult: DialResult,
    private readonly reconciliation: DialReconciliation = { kind: 'pending' },
  ) {}
  async dial(_request: TelephonyDialRequest) {
    this.dials += 1;
    return this.dialResult;
  }
  async reconcile() {
    this.reconciliations += 1;
    return this.reconciliation;
  }
  async hangup() {}
  async transfer() {}
}

describe('worker admission simulation', () => {
  it('does not dial before readiness', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueue();
    const telephony = new FakeTelephony({ kind: 'accepted', requestId: 'r', carrierCallId: 'CA1' });
    const worker = new WorkerRunner(
      'worker-1',
      store,
      queue,
      {
        async check() {
          return { ready: false as const, reason: 'plugins-not-ready' };
        },
      },
      new FakeProtection(true),
      telephony,
    );
    expect(await worker.handle(delivery)).toEqual({
      kind: 'deferred',
      reason: 'plugins-not-ready',
    });
    expect(telephony.dials).toBe(0);
  });

  it('blocks dialing when ECS task protection cannot be established', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueue();
    const telephony = new FakeTelephony({ kind: 'accepted', requestId: 'r', carrierCallId: 'CA1' });
    const worker = new WorkerRunner(
      'worker-1',
      store,
      queue,
      {
        async check() {
          return { ready: true as const };
        },
      },
      new FakeProtection(false),
      telephony,
    );
    expect(await worker.handle(delivery)).toEqual({
      kind: 'deferred',
      reason: 'task-protection-establish-failed',
    });
    expect(telephony.dials).toBe(0);
  });

  it('persists an unknown dial and reconciles once without retrying dial', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueue();
    const telephony = new FakeTelephony({
      kind: 'unknown',
      requestId: `${delivery.reference.jobId}:1`,
      reason: 'timeout-after-write',
    });
    const worker = new WorkerRunner(
      'worker-1',
      store,
      queue,
      {
        async check() {
          return { ready: true as const };
        },
      },
      new FakeProtection(true),
      telephony,
    );
    expect(await worker.handle(delivery)).toEqual({
      kind: 'reconcile_required',
      jobId: delivery.reference.jobId,
      requestId: `${delivery.reference.jobId}:1`,
    });
    expect(store.state).toBe('reconcile_required');
    expect(telephony.dials).toBe(1);
    expect(telephony.reconciliations).toBe(1);
    expect(queue.deleted).toBe(0);
    expect(queue.visibilityChanges).toBe(1);
  });

  it('reconciles an accepted crash-left dial without invoking dial again', async () => {
    const store = new MemoryStore();
    store.claimMode = 'reconcile';
    store.state = 'dialing';
    const queue = new MemoryQueue();
    const telephony = new FakeTelephony(
      { kind: 'rejected', requestId: 'unused', reason: 'must-not-dial', retryable: false },
      { kind: 'accepted', carrierCallId: 'CA-reconciled' },
    );
    const worker = new WorkerRunner(
      'worker-2',
      store,
      queue,
      {
        async check() {
          return { ready: false as const, reason: 'not-needed-for-reconcile' };
        },
      },
      new FakeProtection(false),
      telephony,
    );
    expect(await worker.handle(delivery)).toEqual({
      kind: 'reconciled',
      jobId: delivery.reference.jobId,
      carrierCallId: 'CA-reconciled',
    });
    expect(telephony.dials).toBe(0);
    expect(telephony.reconciliations).toBe(1);
    expect(queue.deleted).toBe(1);
    expect(store.state).toBe('accepted');
  });

  it.each(['currently_leased', 'not_before'] as const)(
    'retains a %s receipt by changing visibility instead of deleting',
    async (reason) => {
      const store = new MemoryStore();
      store.claimMode = 'defer';
      store.deferReason = reason;
      const queue = new MemoryQueue();
      const telephony = new FakeTelephony({
        kind: 'rejected',
        requestId: 'unused',
        reason: 'unused',
        retryable: false,
      });
      const worker = new WorkerRunner(
        'worker-duplicate',
        store,
        queue,
        {
          async check() {
            return { ready: true as const };
          },
        },
        new FakeProtection(true),
        telephony,
      );
      expect(await worker.handle(delivery)).toMatchObject({ kind: 'deferred', reason });
      expect(queue.deleted).toBe(0);
      expect(queue.visibilityChanges).toBe(1);
      expect(telephony.dials).toBe(0);
    },
  );
});

describe.skipIf(!process.env.OVO_TEST_POSTGRES_URL)(
  'worker PostgreSQL crash reconciliation',
  () => {
    it('accepts the redelivery through reconciliation without redial and rejects the stale owner', async () => {
      const store = new PostgresOrchestrationStore({
        connectionString: process.env.OVO_TEST_POSTGRES_URL,
      });
      await store.migrate();
      const jobId = randomUUID();
      const workspaceId = `worker-pg-${jobId}`;
      try {
        await store.enqueue({ id: jobId, workspaceId, idempotencyKey: 'crash-dial', payload: {} });
        const first = await store.claim(jobId, 'crashed-worker', 60_000);
        expect(first.kind).toBe('execute');
        if (first.kind !== 'execute') throw new Error('expected execution claim');
        const requestId = `${jobId}:${first.job.ownerEpoch}`;
        expect(
          await store.beginDial(jobId, first.job.ownerId, first.job.ownerEpoch, requestId),
        ).toBe(true);
        await store.pool.query(
          `UPDATE ovo_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
          [jobId],
        );

        const queue = new MemoryQueue();
        const telephony = new FakeTelephony(
          { kind: 'rejected', requestId: 'must-not-run', reason: 'must-not-run', retryable: false },
          { kind: 'accepted', carrierCallId: 'CA-real-pg-reconciled' },
        );
        const worker = new WorkerRunner(
          'reconciliation-worker',
          store,
          queue,
          {
            async check() {
              return { ready: false as const, reason: 'dial-path-must-not-run' };
            },
          },
          new FakeProtection(false),
          telephony,
        );
        const redelivery: QueueDelivery = {
          ...delivery,
          reference: { schemaVersion: 1, jobId },
        };
        expect(await worker.handle(redelivery)).toEqual({
          kind: 'reconciled',
          jobId,
          carrierCallId: 'CA-real-pg-reconciled',
        });
        expect(telephony.dials).toBe(0);
        expect(queue.deleted).toBe(1);
        expect(
          await store.markDialAccepted(
            jobId,
            first.job.ownerId,
            first.job.ownerEpoch,
            requestId,
            'CA-stale',
          ),
        ).toBe(false);
      } finally {
        await store.pool.query('DELETE FROM ovo_outbox WHERE aggregate_id = $1', [jobId]);
        await store.pool.query('DELETE FROM ovo_jobs WHERE id = $1', [jobId]);
        await store.close();
      }
    });
  },
);
