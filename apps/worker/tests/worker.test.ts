import { describe, expect, it } from 'vitest';
import { WorkerRunner } from '../src/index.ts';
import type {
  ClaimedJob,
  DialReconciliation,
  DialResult,
  DurableJob,
  DurableJobStore,
  DurableQueue,
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

  async enqueue(): Promise<{ job: DurableJob; created: boolean }> {
    throw new Error('not used');
  }
  async claim(jobId: string, workerId: string): Promise<ClaimedJob | undefined> {
    if (this.state !== 'queued') return undefined;
    this.claims += 1;
    this.state = 'owned';
    return {
      id: jobId,
      workspaceId: 'ws-1',
      idempotencyKey: 'key-1',
      status: 'owned',
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
    expect(queue.deleted).toBe(1);
  });
});
