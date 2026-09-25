import type { DurableJob } from '@winsendotai/ovo-plugin-orchestration';

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
