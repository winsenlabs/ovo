import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgresOperationsService,
  type CampaignConfig,
  type HandoffProviderPort,
  type HandoffProviderResult,
  type HandoffReconciliation,
} from '../src/index.ts';

class FakeHandoffProvider implements HandoffProviderPort {
  requests = 0;
  fallbacks = 0;
  requestResult: HandoffProviderResult = { kind: 'confirmed', receiptId: 'default-transfer' };
  fallbackResult: HandoffProviderResult = { kind: 'confirmed', receiptId: 'default-fallback' };
  reconciliation: HandoffReconciliation = { kind: 'pending' };

  async request(): Promise<HandoffProviderResult> {
    this.requests += 1;
    return this.requestResult;
  }

  async reconcile(): Promise<HandoffReconciliation> {
    return this.reconciliation;
  }

  async fallback(): Promise<HandoffProviderResult> {
    this.fallbacks += 1;
    return this.fallbackResult;
  }
}

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
describe.skipIf(!postgresUrl)('PostgreSQL production operations', () => {
  const organizationId = `one-org-${randomUUID()}`;
  const provider = new FakeHandoffProvider();
  let service: PostgresOperationsService;

  const campaignConfig = (overrides: Partial<CampaignConfig> = {}): CampaignConfig => ({
    operationId: `campaign-${randomUUID()}`,
    name: 'PG operations fixture',
    agentReleaseId: 'release-1',
    fromNumber: '+14155550000',
    schedule: { localDateTime: '2026-01-15T12:00', timezone: 'UTC' },
    perNumberAttemptLimit: 2,
    maxAttemptsTotal: 20,
    maxAttemptsPerLocalDay: 20,
    activeCallPolicy: 'continue',
    ...overrides,
  });

  async function createCampaign(phone = '+14155550100', overrides: Partial<CampaignConfig> = {}) {
    return service.campaigns.create(campaignConfig(overrides), [
      {
        sourceRow: 2,
        phoneNumber: phone,
        externalId: `customer-${phone}`,
        variables: { name: 'A' },
      },
    ]);
  }

  beforeAll(async () => {
    service = new PostgresOperationsService({
      connectionString: postgresUrl,
      organizationId,
      handoffProvider: provider,
    });
    await service.migrate();
  });

  afterAll(async () => {
    if (!service) return;
    await service.pool.query(
      `DELETE FROM ovo_ops_outbox WHERE payload->>'campaignId' IN
       (SELECT id::text FROM ovo_ops_campaigns WHERE organization_id = $1)`,
      [organizationId],
    );
    await service.pool.query('DELETE FROM ovo_ops_handoffs WHERE organization_id = $1', [
      organizationId,
    ]);
    await service.pool.query('DELETE FROM ovo_ops_inbound_admissions WHERE organization_id = $1', [
      organizationId,
    ]);
    await service.pool.query('DELETE FROM ovo_ops_inbound_capacity WHERE organization_id = $1', [
      organizationId,
    ]);
    await service.pool.query('DELETE FROM ovo_ops_suppressions WHERE organization_id = $1', [
      organizationId,
    ]);
    await service.pool.query('DELETE FROM ovo_ops_campaigns WHERE organization_id = $1', [
      organizationId,
    ]);
    await service.close();
  });

  it('serializes pause against dequeue authorization and stops every later admission', async () => {
    const campaign = await service.campaigns.create(campaignConfig(), [
      { sourceRow: 2, phoneNumber: '+14155550101', variables: {} },
      { sourceRow: 3, phoneNumber: '+14155550102', variables: {} },
    ]);
    const admitted = await service.campaigns.admit(campaign.id, 'worker-race', 60_000);
    expect(admitted.kind).toBe('admitted');
    if (admitted.kind !== 'admitted') return;

    const [pause, authorization] = await Promise.all([
      service.campaigns.command(campaign.id, 'pause', campaign.version),
      service.campaigns.authorizeDial(admitted.contactId, 'worker-race', admitted.ownerEpoch),
    ]);
    expect(pause.kind).toBe('applied');
    expect(['authorized', 'blocked']).toContain(authorization.kind);
    expect(await service.campaigns.admit(campaign.id, 'worker-after-pause', 60_000)).toMatchObject({
      kind: 'campaign_not_running',
      status: 'paused',
    });
    if (authorization.kind === 'blocked')
      expect(authorization.reason).toMatch(/campaign_not_running|lease_lost/);
  });

  it('invalidates admission epochs atomically across pause, resume, and cancel', async () => {
    const campaign = await createCampaign('+14155550106');
    const first = await service.campaigns.admit(campaign.id, 'worker-old', 60_000);
    if (first.kind !== 'admitted') throw new Error('expected first admission');
    const paused = await service.campaigns.command(campaign.id, 'pause', campaign.version);
    if (paused.kind !== 'applied') throw new Error('expected pause');
    const resumed = await service.campaigns.command(campaign.id, 'resume', paused.campaign.version);
    if (resumed.kind !== 'applied') throw new Error('expected resume');
    expect(
      await service.campaigns.authorizeDial(first.contactId, 'worker-old', first.ownerEpoch),
    ).toEqual({
      kind: 'blocked',
      reason: 'lease_lost',
    });
    const fresh = await service.campaigns.admit(campaign.id, 'worker-new', 60_000);
    expect(fresh).toMatchObject({
      kind: 'admitted',
      contactId: first.contactId,
      ownerEpoch: first.ownerEpoch + 1,
    });
    if (fresh.kind !== 'admitted') return;
    const cancelled = await service.campaigns.command(
      campaign.id,
      'cancel',
      resumed.campaign.version,
    );
    expect(cancelled.kind).toBe('applied');
    expect(
      await service.campaigns.authorizeDial(fresh.contactId, 'worker-new', fresh.ownerEpoch),
    ).toEqual({
      kind: 'blocked',
      reason: 'campaign_not_running',
    });
    expect((await service.campaigns.counters(campaign.id)).contacts.cancelled).toBe(1);
  });

  it('deduplicates concurrent campaign creation and rejects operation-ID collisions', async () => {
    const config = campaignConfig();
    const contacts = [{ sourceRow: 2, phoneNumber: '+14155550107', variables: { name: 'same' } }];
    const [left, right] = await Promise.all([
      service.campaigns.create(config, contacts),
      service.campaigns.create(config, contacts),
    ]);
    expect(left.id).toBe(right.id);
    await expect(
      service.campaigns.create({ ...config, name: 'different payload' }, contacts),
    ).rejects.toThrow('operationId collision');
  });

  it('rechecks suppression transactionally after queue dispatch and immediately before dial', async () => {
    const phone = '+14155550103';
    const campaign = await createCampaign(phone);
    const admitted = await service.campaigns.admit(campaign.id, 'worker-suppression', 60_000);
    expect(admitted.kind).toBe('admitted');
    if (admitted.kind !== 'admitted') return;
    await service.campaigns.suppress(phone, 'customer request after enqueue');
    expect(
      await service.campaigns.authorizeDial(
        admitted.contactId,
        'worker-suppression',
        admitted.ownerEpoch,
      ),
    ).toEqual({ kind: 'blocked', reason: 'suppressed' });
    const persisted = await service.pool.query<{ outbox: string; attempts: string }>(
      `SELECT
        (SELECT count(*) FROM ovo_ops_outbox WHERE payload->>'campaignId' = $1)::text AS outbox,
        (SELECT count(*) FROM ovo_ops_attempts WHERE campaign_id = $1::uuid)::text AS attempts`,
      [campaign.id],
    );
    expect(persisted.rows[0]).toEqual({ outbox: '1', attempts: '0' });
  });

  it('deduplicates attempt events and derives counters from persisted states', async () => {
    const campaign = await createCampaign('+14155550104');
    const admitted = await service.campaigns.admit(campaign.id, 'worker-counter', 60_000);
    if (admitted.kind !== 'admitted') throw new Error('expected contact admission');
    const authorization = await service.campaigns.authorizeDial(
      admitted.contactId,
      'worker-counter',
      admitted.ownerEpoch,
    );
    if (authorization.kind !== 'authorized') throw new Error('expected dial authorization');
    expect(
      await service.campaigns.authorizeDial(
        admitted.contactId,
        'worker-counter',
        admitted.ownerEpoch,
      ),
    ).toEqual(authorization);
    expect(
      await service.campaigns.recordAttempt(
        authorization.attemptId,
        'event-terminal',
        'succeeded',
        new Date(),
      ),
    ).toBe('applied');
    expect(
      await service.campaigns.recordAttempt(
        authorization.attemptId,
        'event-terminal',
        'succeeded',
        new Date(),
      ),
    ).toBe('duplicate');
    expect(
      await service.campaigns.recordAttempt(
        authorization.attemptId,
        'event-late',
        'failed',
        new Date(),
      ),
    ).toBe('ignored_terminal');
    expect(await service.campaigns.counters(campaign.id)).toMatchObject({
      contacts: { succeeded: 1 },
      attempts: { succeeded: 1, failed: 0 },
    });
    const claimed = await service.outbox.claim('dispatcher-counter', 1000);
    expect(claimed.filter((record) => record.payload.campaignId === campaign.id)).toHaveLength(1);
  });

  it('enforces persisted per-number attempts and total quotas during authorization', async () => {
    const campaign = await createCampaign('+14155550105', {
      perNumberAttemptLimit: 1,
      maxAttemptsTotal: 1,
      maxAttemptsPerLocalDay: 1,
    });
    const admitted = await service.campaigns.admit(campaign.id, 'worker-quota', 60_000);
    if (admitted.kind !== 'admitted') throw new Error('expected contact admission');
    const authorization = await service.campaigns.authorizeDial(
      admitted.contactId,
      'worker-quota',
      admitted.ownerEpoch,
    );
    if (authorization.kind !== 'authorized') throw new Error('expected authorization');
    await service.campaigns.recordAttempt(
      authorization.attemptId,
      'quota-failed',
      'failed',
      new Date(),
    );
    expect(await service.retries.redrive(admitted.contactId, new Date())).toEqual({
      kind: 'blocked',
      reason: 'attempt_limit',
    });
    expect(await service.campaigns.admit(campaign.id, 'worker-quota-2', 60_000)).toEqual({
      kind: 'quota_exhausted',
      quota: 'total',
    });
  });

  it('admits inbound only onto ready protected unreserved capacity and persists overflow', async () => {
    const zero = await service.inbound.admit('CA-zero', {
      kind: 'busy',
      reason: 'no warm capacity',
    });
    expect(zero).toMatchObject({ kind: 'busy', reason: 'no warm capacity' });
    await service.inbound.registerProtectedCapacity({
      slotId: `slot-${randomUUID()}`,
      workerId: 'worker-cold',
      workerEndpoint: 'wss://worker-cold.test/media',
      generation: 1,
      ready: false,
      protectedUntil: new Date(Date.now() + 60_000),
    });
    expect(await service.inbound.readyProtectedCapacity()).toBe(0);
    const slotId = `slot-${randomUUID()}`;
    await service.inbound.registerProtectedCapacity({
      slotId,
      workerId: 'worker-warm',
      workerEndpoint: 'wss://worker-warm.test/media',
      generation: 1,
      ready: true,
      protectedUntil: new Date(Date.now() + 60_000),
    });
    const reserved = await service.inbound.admit('CA-warm', {
      kind: 'wait',
      maxWaitMs: 10_000,
      announcement: 'Please wait',
    });
    expect(reserved).toMatchObject({ kind: 'reserved', slotId, workerId: 'worker-warm' });
    expect(await service.inbound.admit('CA-warm', { kind: 'busy', reason: 'duplicate' })).toEqual(
      reserved,
    );
    expect(
      await service.inbound.admit('CA-overflow', {
        kind: 'human',
        target: '+14155550999',
        announcement: 'Connecting',
      }),
    ).toMatchObject({ kind: 'human', target: '+14155550999' });
    await service.inbound.release(reserved.admissionId);
    expect(await service.inbound.readyProtectedCapacity()).toBe(1);
  });

  it('never retries an unknown handoff blindly and requires a provider receipt for confirmation', async () => {
    provider.requests = 0;
    provider.requestResult = { kind: 'unknown', reason: 'timeout after request bytes' };
    provider.reconciliation = { kind: 'pending' };
    const request = {
      operationId: `handoff-${randomUUID()}`,
      sessionId: 'session-unknown',
      carrierCallId: 'CA-handoff-unknown',
      target: { kind: 'queue', value: 'human-sales' },
      fallback: { kind: 'resume', message: 'I could not transfer you.' },
      confirmationRequired: true,
    } as const;
    const handoff = await service.handoffs.request(request);
    expect((await service.handoffs.request(request)).id).toBe(handoff.id);
    expect((await service.handoffs.confirm(handoff.id, true)).status).toBe('ready');
    expect((await service.handoffs.execute(handoff.id)).status).toBe('unknown');
    expect(provider.requests).toBe(1);
    expect((await service.handoffs.execute(handoff.id)).status).toBe('unknown');
    expect((await service.handoffs.retry(handoff.id)).status).toBe('unknown');
    expect(provider.requests).toBe(1);
    provider.reconciliation = { kind: 'confirmed', receiptId: 'provider-transfer-receipt' };
    expect(await service.handoffs.reconcile(handoff.id)).toMatchObject({
      status: 'confirmed',
      providerReceiptId: 'provider-transfer-receipt',
    });
  });

  it('routes definitive handoff failure through the provider fallback without false transfer success', async () => {
    provider.requestResult = { kind: 'rejected', reason: 'target unavailable', retryable: false };
    provider.fallbackResult = { kind: 'confirmed', receiptId: 'fallback-played-receipt' };
    const handoff = await service.handoffs.request({
      operationId: `handoff-${randomUUID()}`,
      sessionId: 'session-fallback',
      carrierCallId: 'CA-handoff-fallback',
      target: { kind: 'phone', value: '+14155550999' },
      fallback: { kind: 'resume', message: 'The transfer failed. I can continue helping.' },
      confirmationRequired: false,
    });
    expect(await service.handoffs.execute(handoff.id)).toMatchObject({
      status: 'fallback_completed',
      providerReceiptId: 'fallback-played-receipt',
    });
    expect(provider.fallbacks).toBeGreaterThan(0);
  });

  it('does not retry an unknown fallback until reconciliation certifies not-found', async () => {
    provider.requestResult = { kind: 'rejected', reason: 'target unavailable', retryable: false };
    provider.fallbackResult = { kind: 'unknown', reason: 'fallback response lost' };
    provider.reconciliation = { kind: 'pending' };
    const handoff = await service.handoffs.request({
      operationId: `handoff-${randomUUID()}`,
      sessionId: 'session-fallback-unknown',
      carrierCallId: 'CA-handoff-fallback-unknown',
      target: { kind: 'queue', value: 'human-sales' },
      fallback: { kind: 'resume', message: 'I can continue helping.' },
      confirmationRequired: false,
    });
    const uncertain = await service.handoffs.execute(handoff.id);
    expect(uncertain.status).toBe('fallback_unknown');
    const calls = provider.fallbacks;
    expect((await service.handoffs.retryFallback(handoff.id)).status).toBe('fallback_unknown');
    expect((await service.handoffs.reconcile(handoff.id)).status).toBe('fallback_unknown');
    expect(provider.fallbacks).toBe(calls);
    provider.reconciliation = { kind: 'not_found' };
    expect(await service.handoffs.reconcile(handoff.id)).toMatchObject({
      status: 'fallback_failed',
      retryable: true,
    });
    provider.fallbackResult = { kind: 'confirmed', receiptId: 'fallback-retry-receipt' };
    expect(await service.handoffs.retryFallback(handoff.id)).toMatchObject({
      status: 'fallback_completed',
      providerReceiptId: 'fallback-retry-receipt',
      fallbackAttempt: 2,
    });
  });
});
