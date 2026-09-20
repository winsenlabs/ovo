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
import { reconcileClaimedDial, type ReconciliationOutcome } from './reconciliation.ts';
import { dialRequestFromJob } from './dial-request.ts';

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
  | ReconciliationOutcome
  | { kind: 'failed'; reason: string };

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
    const claim = await this.store.claim(
      delivery.reference.jobId,
      this.workerId,
      this.options.leaseMs,
    );
    if (claim.kind === 'defer') {
      const delay = claim.retryAt
        ? Math.max(1, Math.min(43_200, Math.ceil((claim.retryAt.getTime() - Date.now()) / 1_000)))
        : this.options.deferSeconds;
      await this.queue.changeVisibility(delivery, delay);
      return { kind: 'deferred', reason: claim.reason };
    }
    if (claim.kind === 'missing' || claim.kind === 'settled') {
      await this.queue.delete(delivery);
      return { kind: 'duplicate' };
    }
    const job = claim.job;
    if (claim.kind === 'reconcile') {
      return reconcileClaimedDial({
        workerId: this.workerId,
        job,
        delivery,
        store: this.store,
        queue: this.queue,
        telephony: this.telephony,
        deferSeconds: this.options.deferSeconds,
      });
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
      request = dialRequestFromJob(job.payload, job);
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

    const unknownPersisted = await this.store.markDialUnknown(
      job.id,
      this.workerId,
      job.ownerEpoch,
      request.requestId,
      dial.reason,
    );
    if (!unknownPersisted) {
      lease.stop();
      visibility.stop();
      await renewal.release();
      await this.queue.changeVisibility(delivery, this.options.deferSeconds);
      return { kind: 'deferred', reason: 'dial-ownership-lost' };
    }
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
    if (reconciled.kind === 'rejected') {
      await this.store.markFailed(job.id, this.workerId, job.ownerEpoch, reconciled.reason);
      await this.queue.delete(delivery);
      lease.stop();
      visibility.stop();
      await renewal.release();
      return { kind: 'failed', reason: reconciled.reason };
    }
    const deferred = await this.store.deferReconciliation(
      job.id,
      this.workerId,
      job.ownerEpoch,
      'carrier-outcome-still-pending',
      new Date(Date.now() + this.options.deferSeconds * 1_000),
    );
    await this.queue.changeVisibility(delivery, this.options.deferSeconds);
    lease.stop();
    visibility.stop();
    await renewal.release();
    if (!deferred) return { kind: 'deferred', reason: 'reconciliation-ownership-lost' };
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
