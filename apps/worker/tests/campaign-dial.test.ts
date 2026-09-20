import { describe, expect, it, vi } from 'vitest';
import { authorizeCampaignPayload, recordCampaignAttempt } from '../src/campaign-dial.ts';

const job = {
  id: 'job-1',
  workspaceId: 'workspace-1',
  idempotencyKey: 'campaign-1:contact-1:3',
  status: 'owned' as const,
  ownerId: 'worker-1',
  ownerEpoch: 1,
  leaseExpiresAt: new Date(Date.now() + 60_000),
  payload: {
    kind: 'campaign_dial_candidate',
    contactId: 'contact-1',
    admissionOwnerId: 'admission-1',
    admissionEpoch: 3,
  },
};

describe('campaign dial authorization adapter', () => {
  it('uses the admission capability once and returns durable live payload fields', async () => {
    const authorizeDial = vi.fn(async () => ({
      kind: 'authorized' as const,
      attemptId: 'attempt-1',
      campaignId: 'campaign-1',
      to: '+910000000011',
      from: '+910000000022',
      agentReleaseId: 'release-1',
      variables: { name: 'Ada' },
    }));
    const result = await authorizeCampaignPayload({
      job,
      campaigns: { authorizeDial },
      streamUrl: 'wss://voice.example.test/twilio/media',
      statusCallbackUrl: 'https://voice.example.test/twilio/status',
    });
    expect(authorizeDial).toHaveBeenCalledOnce();
    expect(authorizeDial).toHaveBeenCalledWith('contact-1', 'admission-1', 3);
    expect(result).toMatchObject({
      kind: 'authorized',
      payload: {
        releaseId: 'release-1',
        callId: 'job-1',
        attemptId: 'attempt-1',
        to: '+910000000011',
        from: '+910000000022',
      },
    });
  });

  it('fails closed before authorization when live routing is not composed', async () => {
    const authorizeDial = vi.fn();
    await expect(authorizeCampaignPayload({ job, campaigns: { authorizeDial } })).resolves.toEqual({
      kind: 'blocked',
      reason: 'campaign-dial-runtime-not-composed',
    });
    expect(authorizeDial).not.toHaveBeenCalled();
  });

  it('projects worker dial settlement onto the authorized campaign attempt', async () => {
    const recordAttempt = vi.fn(async () => ({ kind: 'applied' as const }));
    await recordCampaignAttempt(
      { authorizeDial: vi.fn(), recordAttempt },
      { attemptId: 'attempt-1' },
      'accepted:CA1',
      'dialing',
    );
    expect(recordAttempt).toHaveBeenCalledWith(
      'attempt-1',
      'accepted:CA1',
      'dialing',
      expect.any(Date),
      undefined,
    );
  });
});
