import { definePlugin, type Context } from '@winsendotai/ovo-runtime';
import {
  ProtectionRenewal,
  type DurableJobStore,
  type DurableQueue,
  type QueueDelivery,
  type ReadinessProbe,
  type TaskProtection,
  type TelephonyControl,
  type TelephonyDialRequest,
} from '@winsendotai/ovo-plugin-orchestration';
import { DeliveryVisibilityRenewal, JobLeaseRenewal } from './renewal.ts';

export type DeliveryOutcome =
  | { kind: 'duplicate' }
  | { kind: 'deferred'; reason: string }
  | {
      kind: 'accepted';
      jobId: string;
      carrierCallId: string;
      protection: ProtectionRenewal;
      lease: JobLeaseRenewal;
    }
  | { kind: 'reconcile_required'; jobId: string; requestId: string }
  | { kind: 'failed'; reason: string };

function dialPayload(
  payload: Record<string, unknown>,
  job: { id: string; workspaceId: string; ownerEpoch: number },
): TelephonyDialRequest {
  const read = (key: string): string => {
    const value = payload[key];
    if (typeof value !== 'string' || !value) throw new Error(`Job ${job.id} is missing ${key}`);
    return value;
  };
  return {
    requestId: `${job.id}:${job.ownerEpoch}`,
    jobId: job.id,
    workspaceId: job.workspaceId,
    to: read('to'),
    from: read('from'),
    streamUrl: read('streamUrl'),
    statusCallbackUrl: read('statusCallbackUrl'),
  };
}

export class WorkerRunner {
  private draining = false;

  constructor(
    private readonly workerId: string,
    private readonly store: DurableJobStore,
    private readonly queue: DurableQueue,
    private readonly readiness: ReadinessProbe,
    private readonly protection: TaskProtection,
    private readonly telephony: TelephonyControl,
    private readonly options: {
      leaseMs: number;
      protectionRenewMs: number;
      deferSeconds: number;
      visibilitySeconds: number;
    } = {
      leaseMs: 60_000,
      protectionRenewMs: 120_000,
      deferSeconds: 5,
      visibilitySeconds: 120,
    },
  ) {}

  beginDrain(): void {
    this.draining = true;
  }

  async handle(delivery: QueueDelivery): Promise<DeliveryOutcome> {
    if (this.draining) {
      await this.queue.changeVisibility(delivery, this.options.deferSeconds);
      return { kind: 'deferred', reason: 'worker-draining' };
    }
    const job = await this.store.claim(
      delivery.reference.jobId,
      this.workerId,
      this.options.leaseMs,
    );
    if (!job) {
      await this.queue.delete(delivery);
      return { kind: 'duplicate' };
    }
    const lease = new JobLeaseRenewal(
      this.store,
      {
        jobId: job.id,
        workerId: this.workerId,
        epoch: job.ownerEpoch,
      },
      this.options.leaseMs,
      () => {
        this.draining = true;
      },
    );
    const visibility = new DeliveryVisibilityRenewal(
      this.queue,
      delivery,
      this.options.visibilitySeconds,
    );
    lease.start();
    visibility.start();
    const readiness = await this.readiness.check();
    if (!readiness.ready) {
      lease.stop();
      visibility.stop();
      await this.store.release(
        job.id,
        this.workerId,
        job.ownerEpoch,
        `readiness:${readiness.reason}`,
      );
      await this.queue.changeVisibility(delivery, this.options.deferSeconds);
      return { kind: 'deferred', reason: readiness.reason };
    }

    const renewal = new ProtectionRenewal(
      this.protection,
      this.options.protectionRenewMs,
      async () => {
        this.draining = true;
        await this.store.markDialUnknown(
          job.id,
          this.workerId,
          job.ownerEpoch,
          job.dialRequestId ?? `${job.id}:${job.ownerEpoch}`,
          'task-protection-renewal-failed',
        );
      },
    );
    if (!(await renewal.establish())) {
      this.draining = true;
      lease.stop();
      visibility.stop();
      await this.store.release(
        job.id,
        this.workerId,
        job.ownerEpoch,
        'task-protection-establish-failed',
      );
      await this.queue.changeVisibility(delivery, this.options.deferSeconds);
      return { kind: 'deferred', reason: 'task-protection-establish-failed' };
    }

    let request: TelephonyDialRequest;
    try {
      request = dialPayload(job.payload, job);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.store.markFailed(job.id, this.workerId, job.ownerEpoch, reason);
      await this.queue.delete(delivery);
      lease.stop();
      visibility.stop();
      await renewal.release();
      return { kind: 'failed', reason };
    }
    if (!(await this.store.beginDial(job.id, this.workerId, job.ownerEpoch, request.requestId))) {
      lease.stop();
      visibility.stop();
      await renewal.release();
      await this.queue.delete(delivery);
      return { kind: 'duplicate' };
    }

    const dial = await this.telephony.dial(request).catch((error: unknown) => ({
      kind: 'unknown' as const,
      requestId: request.requestId,
      reason: error instanceof Error ? error.message : String(error),
    }));
    if (dial.kind === 'accepted') {
      await this.store.markDialAccepted(
        job.id,
        this.workerId,
        job.ownerEpoch,
        request.requestId,
        dial.carrierCallId,
      );
      await this.queue.delete(delivery);
      visibility.stop();
      return {
        kind: 'accepted',
        jobId: job.id,
        carrierCallId: dial.carrierCallId,
        protection: renewal,
        lease,
      };
    }
    if (dial.kind === 'rejected') {
      await this.store.markFailed(job.id, this.workerId, job.ownerEpoch, dial.reason);
      await this.queue.delete(delivery);
      lease.stop();
      visibility.stop();
      await renewal.release();
      return { kind: 'failed', reason: dial.reason };
    }

    await this.store.markDialUnknown(
      job.id,
      this.workerId,
      job.ownerEpoch,
      request.requestId,
      dial.reason,
    );
    const reconciled = await this.telephony.reconcile(request.requestId);
    if (reconciled.kind === 'accepted') {
      await this.store.markDialAccepted(
        job.id,
        this.workerId,
        job.ownerEpoch,
        request.requestId,
        reconciled.carrierCallId,
      );
      await this.queue.delete(delivery);
      visibility.stop();
      return {
        kind: 'accepted',
        jobId: job.id,
        carrierCallId: reconciled.carrierCallId,
        protection: renewal,
        lease,
      };
    }
    await this.queue.delete(delivery);
    lease.stop();
    visibility.stop();
    await renewal.release();
    return { kind: 'reconcile_required', jobId: job.id, requestId: request.requestId };
  }
}

export const workerRunnerPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-worker/runner',
    version: '0.1.0',
    contractVersion: 1,
    scope: 'process',
    requires: [
      'orchestration.store',
      'orchestration.queue',
      'worker.readiness',
      'worker.protection',
      'telephony.control',
    ],
    provides: ['worker.runner'],
    configSchema: {
      type: 'object',
      required: ['workerId'],
      properties: { workerId: { type: 'string' } },
    },
    secretFields: [],
  },
  (ctx: Context, config) => {
    if (typeof config.workerId !== 'string' || !config.workerId)
      throw new Error('Missing workerId');
    ctx.provide(
      'worker.runner',
      new WorkerRunner(
        config.workerId,
        ctx.get('orchestration.store') as DurableJobStore,
        ctx.get('orchestration.queue') as DurableQueue,
        ctx.get('worker.readiness') as ReadinessProbe,
        ctx.get('worker.protection') as TaskProtection,
        ctx.get('telephony.control') as TelephonyControl,
      ),
    );
  },
);
