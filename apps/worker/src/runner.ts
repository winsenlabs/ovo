import {
  ProtectionRenewal,
  type DurableJobStore,
  type DurableQueue,
  type QueueDelivery,
  type ReadinessProbe,
  type TaskProtection,
  type TelephonyControl,
} from '@winsendotai/ovo-plugin-orchestration';
import { startDeliveryRenewals } from './renewal.ts';
import { claimWorkerDelivery } from './claim-delivery.ts';
import { authorizeCampaignPayload, recordCampaignAttempt } from './campaign-dial.ts';
import { failBeforeDial } from './worker-cleanup.ts';
import { dialOwnedJob } from './worker-dial.ts';
import type { DeliveryOutcome } from './worker-types.ts';
import { DEFAULT_WORKER_RUNNER_OPTIONS, type WorkerRunnerOptions } from './worker-options.ts';

export class WorkerRunner {
  private draining = false;
  private terminationHandler?: (
    jobId: string,
    ownerEpoch: number,
    reason: string,
  ) => Promise<boolean>;

  constructor(
    private readonly workerId: string,
    private readonly store: DurableJobStore,
    private readonly queue: DurableQueue,
    private readonly readiness: ReadinessProbe,
    private readonly protection: TaskProtection,
    private readonly telephony: TelephonyControl,
    private readonly options: WorkerRunnerOptions = DEFAULT_WORKER_RUNNER_OPTIONS,
  ) {}

  beginDrain(): void {
    this.draining = true;
  }

  setTerminationHandler(
    handler: (jobId: string, ownerEpoch: number, reason: string) => Promise<boolean>,
  ): void {
    this.terminationHandler = handler;
  }

  async handle(delivery: QueueDelivery): Promise<DeliveryOutcome> {
    if (this.draining) {
      await this.queue.changeVisibility(delivery, this.options.deferSeconds);
      return { kind: 'deferred', reason: 'worker-draining' };
    }
    const claim = await claimWorkerDelivery({
      workerId: this.workerId,
      delivery,
      store: this.store,
      queue: this.queue,
      telephony: this.telephony,
      leaseMs: this.options.leaseMs,
      deferSeconds: this.options.deferSeconds,
      carriers: this.options.carriers,
    });
    if (claim.kind === 'outcome') return claim.outcome;
    const { job } = claim;
    if (this.options.organizationId && job.workspaceId !== this.options.organizationId) {
      const reason = 'job-organization-does-not-match-single-tenant-runtime';
      await this.store.markFailed(job.id, this.workerId, job.ownerEpoch, reason);
      await this.queue.delete(delivery);
      return { kind: 'failed', reason };
    }
    const { lease, visibility } = startDeliveryRenewals({
      store: this.store,
      queue: this.queue,
      delivery,
      job,
      workerId: this.workerId,
      leaseMs: this.options.leaseMs,
      visibilitySeconds: this.options.visibilitySeconds,
      onLeaseLost: async () => {
        this.draining = true;
        const route = await this.store.getSessionRoute(job.id);
        if (route && this.options.carriers) {
          if (!this.terminationHandler)
            throw new Error('Carrier termination handler is not installed');
          await this.terminationHandler(job.id, job.ownerEpoch, 'job-lease-lost');
        }
      },
    });
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

    let activeCarrierCallId: string | undefined;
    const renewal = new ProtectionRenewal(
      this.protection,
      this.options.protectionRenewMs,
      async () => {
        this.draining = true;
        if (this.options.carriers) {
          const route = await this.store.getSessionRoute(job.id);
          if (route) {
            if (!this.terminationHandler)
              throw new Error('Carrier termination handler is not installed');
            await this.terminationHandler(job.id, job.ownerEpoch, 'task-protection-renewal-failed');
          } else {
            await this.store.markDialUnknown(
              job.id,
              this.workerId,
              job.ownerEpoch,
              job.dialRequestId ?? `${job.id}:${job.ownerEpoch}`,
              'task-protection-renewal-failed',
            );
          }
          return;
        }
        if (activeCarrierCallId) {
          const terminating = await this.store.requestSessionTermination(
            job.id,
            this.workerId,
            job.ownerEpoch,
            'task-protection-renewal-failed',
          );
          if (terminating?.carrierCallId) {
            await this.telephony.hangup(terminating.carrierCallId).catch(() => undefined);
          }
        } else {
          await this.store.markDialUnknown(
            job.id,
            this.workerId,
            job.ownerEpoch,
            job.dialRequestId ?? `${job.id}:${job.ownerEpoch}`,
            'task-protection-renewal-failed',
          );
        }
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

    const campaign = await authorizeCampaignPayload({
      job,
      campaigns: this.options.campaigns,
      streamUrl: this.options.streamUrl,
      statusCallbackUrl: this.options.statusCallbackUrl,
      hostRouting: !!this.options.carriers,
    });
    if (campaign.kind === 'blocked')
      return failBeforeDial({
        job,
        workerId: this.workerId,
        store: this.store,
        queue: this.queue,
        delivery,
        lease,
        visibility,
        renewal,
        reason: campaign.reason,
      });
    if (campaign.kind === 'unavailable') {
      lease.stop();
      visibility.stop();
      await renewal.release();
      await this.store.release(job.id, this.workerId, job.ownerEpoch, campaign.reason);
      await this.queue.changeVisibility(delivery, this.options.deferSeconds);
      return { kind: 'deferred', reason: campaign.reason };
    }
    const dialPayload = campaign.payload;
    if (
      campaign.kind === 'authorized' &&
      !(await this.store.updateOwnedPayload(job.id, this.workerId, job.ownerEpoch, dialPayload))
    ) {
      await this.recordAttempt(
        dialPayload,
        `pre-dial:${job.id}:${job.ownerEpoch}`,
        'failed',
        'campaign-payload-ownership-lost',
      );
      lease.stop();
      visibility.stop();
      await renewal.release();
      await this.queue.changeVisibility(delivery, this.options.deferSeconds);
      return { kind: 'deferred', reason: 'campaign-payload-ownership-lost' };
    }
    return dialOwnedJob({
      job,
      dialPayload,
      delivery,
      lease,
      visibility,
      renewal,
      workerId: this.workerId,
      store: this.store,
      queue: this.queue,
      telephony: this.telephony,
      options: this.options,
      recordAttempt: (...args) => this.recordAttempt(...args),
      onCarrierAccepted: (carrierCallId) => {
        activeCarrierCallId = carrierCallId;
      },
    });
  }

  private recordAttempt(
    payload: Record<string, unknown>,
    eventId: string,
    status: 'dialing' | 'failed' | 'unknown',
    reason?: string,
  ) {
    return recordCampaignAttempt(this.options.campaigns, payload, eventId, status, reason).catch(
      () => undefined,
    );
  }
}
