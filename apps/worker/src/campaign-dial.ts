import type {
  ClaimedJob, DurableJob, DurableJobStore, DurableQueue, QueueDelivery, ProtectionRenewal,
} from '@winsendotai/ovo-plugin-orchestration';
import { failBeforeDial } from './worker-cleanup.ts';
import type { JobLeaseRenewal, DeliveryVisibilityRenewal } from './renewal.ts';
import type { DeliveryOutcome } from './worker-types.ts';
import type { WorkerRunnerOptions } from './worker-options.ts';

export interface CampaignDialAuthorizer {
  authorizeDial(
    contactId: string,
    ownerId: string,
    ownerEpoch: number,
  ): Promise<
    | {
        kind: 'authorized';
        attemptId: string;
        campaignId: string;
        to: string;
        from: string;
        agentReleaseId: string;
        variables: Record<string, string>;
      }
    | { kind: 'blocked'; reason: string }
  >;
  recordAttempt?(
    attemptId: string,
    eventId: string,
    status: 'dialing' | 'connected' | 'succeeded' | 'failed' | 'cancelled' | 'unknown',
    occurredAt: Date,
    reason?: string,
  ): Promise<unknown>;
}

export async function recordCampaignAttempt(
  campaigns: CampaignDialAuthorizer | undefined,
  payload: Record<string, unknown>,
  eventId: string,
  status: 'dialing' | 'failed' | 'unknown',
  reason?: string,
) {
  const attemptId = payload.attemptId;
  if (typeof attemptId !== 'string' || !attemptId || !campaigns?.recordAttempt) return;
  await campaigns.recordAttempt(attemptId, eventId, status, new Date(), reason);
}

export async function authorizeCampaignPayload(input: {
  job: DurableJob;
  campaigns?: CampaignDialAuthorizer;
  streamUrl?: string;
  statusCallbackUrl?: string;
  hostRouting?: boolean;
}) {
  if (input.job.payload.kind !== 'campaign_dial_candidate')
    return { kind: 'ordinary' as const, payload: input.job.payload };
  if (!input.campaigns || (!input.hostRouting && (!input.streamUrl || !input.statusCallbackUrl)))
    return { kind: 'blocked' as const, reason: 'campaign-dial-runtime-not-composed' };
  let candidate: ReturnType<typeof campaignCandidate>;
  try {
    candidate = campaignCandidate(input.job.payload);
  } catch (error) {
    return {
      kind: 'blocked' as const,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  let authorization: Awaited<ReturnType<CampaignDialAuthorizer['authorizeDial']>>;
  try {
    authorization = await input.campaigns.authorizeDial(
      candidate.contactId,
      candidate.admissionOwnerId,
      candidate.admissionEpoch,
    );
  } catch (error) {
    return {
      kind: 'unavailable' as const,
      reason: `campaign-authorization-unavailable:${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (authorization.kind === 'blocked')
    return { kind: 'blocked' as const, reason: `campaign-dial-blocked:${authorization.reason}` };
  return {
    kind: 'authorized' as const,
    payload: {
      ...input.job.payload,
      to: authorization.to,
      from: authorization.from,
      releaseId: authorization.agentReleaseId,
      callId: input.job.id,
      attemptId: authorization.attemptId,
      campaignId: authorization.campaignId,
      variables: authorization.variables,
      ...(input.streamUrl ? { streamUrl: input.streamUrl } : {}),
      ...(input.statusCallbackUrl ? { statusCallbackUrl: input.statusCallbackUrl } : {}),
    },
  };
}

function campaignCandidate(payload: Record<string, unknown>) {
  const text = (name: string) => {
    const value = payload[name];
    if (typeof value !== 'string' || !value)
      throw new Error(`campaign candidate is missing ${name}`);
    return value;
  };
  const epoch = payload.admissionEpoch;
  if (!Number.isSafeInteger(epoch) || (epoch as number) < 1)
    throw new Error('campaign candidate has invalid admissionEpoch');
  return {
    contactId: text('contactId'),
    admissionOwnerId: text('admissionOwnerId'),
    admissionEpoch: epoch as number,
  };
}

export async function prepareCampaignDial(input: {
  job: ClaimedJob;
  workerId: string;
  store: DurableJobStore;
  queue: DurableQueue;
  delivery: QueueDelivery;
  lease: JobLeaseRenewal;
  visibility: DeliveryVisibilityRenewal;
  renewal: ProtectionRenewal;
  options: WorkerRunnerOptions;
}): Promise<
  | { kind: 'continue'; payload: Record<string, unknown> }
  | { kind: 'outcome'; outcome: DeliveryOutcome }
> {
  const { job, workerId, store, queue, delivery, lease, visibility, renewal, options } = input;
  const campaign = await authorizeCampaignPayload({
    job,
    campaigns: options.campaigns,
    streamUrl: options.streamUrl,
    statusCallbackUrl: options.statusCallbackUrl,
    hostRouting: !!options.carriers,
  });
  if (campaign.kind === 'blocked' && campaign.reason === 'campaign-dial-blocked:lease_lost') {
    const superseded = await store.markSuperseded(job.id, workerId, job.ownerEpoch, campaign.reason);
    lease.stop();
    visibility.stop();
    await renewal.release();
    if (!superseded)
      return { kind: 'outcome', outcome: { kind: 'deferred', reason: 'campaign-job-ownership-lost' } };
    await queue.delete(delivery);
    return { kind: 'outcome', outcome: { kind: 'failed', reason: campaign.reason } };
  }
  if (campaign.kind === 'blocked')
    return { kind: 'outcome', outcome: await failBeforeDial({
      job, workerId, store, queue, delivery, lease, visibility, renewal, reason: campaign.reason,
    }) };
  if (campaign.kind === 'unavailable') {
    lease.stop();
    visibility.stop();
    await renewal.release();
    await store.release(job.id, workerId, job.ownerEpoch, campaign.reason,
      new Date(Date.now() + options.deferSeconds * 1_000));
    await queue.delete(delivery);
    return { kind: 'outcome', outcome: { kind: 'deferred', reason: campaign.reason } };
  }
  const payload = campaign.payload;
  if (campaign.kind === 'authorized' &&
    !(await store.updateOwnedPayload(job.id, workerId, job.ownerEpoch, payload))) {
    await recordCampaignAttempt(options.campaigns, payload, `pre-dial:${job.id}:${job.ownerEpoch}`,
      'failed', 'campaign-payload-ownership-lost').catch(() => undefined);
    lease.stop();
    visibility.stop();
    await renewal.release();
    await queue.delete(delivery);
    return { kind: 'outcome', outcome: { kind: 'deferred', reason: 'campaign-payload-ownership-lost' } };
  }
  return { kind: 'continue', payload };
}
