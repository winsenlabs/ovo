import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresOrchestrationStore } from '@winsendotai/ovo-plugin-orchestration';
import { authorizeCampaignPayload, recordCampaignAttempt } from '../src/campaign-dial.ts';
import { reconcileClaimedCarrierDial } from '../src/reconciliation.ts';
import { dialOwnedJob } from '../src/worker-dial.ts';

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

describe('carrier dial reconciliation', () => {
  it('persists a fenced deferral before deleting a hint after carrier selection fails', async () => {
    const events: string[] = [];
    const deferReconciliation = vi.fn(async (..._args: [string, string, number, string, Date]) => {
      events.push('defer');
      return true;
    });
    const queue = { delete: vi.fn(async () => { events.push('delete'); }) };
    const delivery = {
      messageId: 'hint-1', receiptHandle: 'receipt-1', receiveCount: 1,
      reference: { schemaVersion: 1 as const, jobId: job.id },
    };
    const reason = 'carrier-reconciliation-unavailable:temporary carrier config outage';
    const result = await reconcileClaimedCarrierDial({
      workerId: 'worker-1',
      job: { ...job, status: 'reconcile_required', dialRequestId: 'dial-1' },
      delivery,
      store: { deferReconciliation } as never,
      queue: queue as never,
      carriers: { forJob: async () => { throw new Error('temporary carrier config outage'); } } as never,
      deferSeconds: 15,
    });
    expect(result).toEqual({ kind: 'deferred', reason });
    expect(deferReconciliation).toHaveBeenCalledWith(
      job.id, 'worker-1', 1, reason, expect.any(Date),
    );
    expect(deferReconciliation.mock.calls[0]?.[4].getTime()).toBeGreaterThan(Date.now() + 14_000);
    expect(events).toEqual(['defer', 'delete']);
  });

  it('keeps the receipt when a stale epoch cannot defer reconciliation', async () => {
    const deleteHint = vi.fn(async () => undefined);
    const result = await reconcileClaimedCarrierDial({
      workerId: 'worker-1',
      job: { ...job, status: 'reconcile_required', dialRequestId: 'dial-1' },
      delivery: {
        messageId: 'hint-2', receiptHandle: 'receipt-2', receiveCount: 1,
        reference: { schemaVersion: 1, jobId: job.id },
      },
      store: { deferReconciliation: async () => false } as never,
      queue: { delete: deleteHint } as never,
      carriers: { forJob: async () => { throw new Error('temporary carrier config outage'); } } as never,
      deferSeconds: 15,
    });
    expect(result).toEqual({ kind: 'deferred', reason: 'reconciliation-ownership-lost' });
    expect(deleteHint).not.toHaveBeenCalled();
  });
});

describe('last pre-dial drain gate', () => {
  it('releases the owned job and protection before creating a route or dialing', async () => {
    const events: string[] = [];
    const release = vi.fn(async () => { events.push('release'); return true; });
    const deleteHint = vi.fn(async () => { events.push('delete'); });
    const releaseProtection = vi.fn(async () => { events.push('protection'); });
    const beginDialSession = vi.fn();
    const dial = vi.fn();
    const result = await dialOwnedJob({
      job: { ...job, id: '00000000-0000-4000-8000-000000000001' },
      dialPayload: {
        to: '+910000000011', from: '+910000000022',
        streamUrl: 'wss://example.test/media', statusCallbackUrl: 'https://example.test/status',
      },
      delivery: {
        messageId: 'hint', receiptHandle: 'receipt', receiveCount: 1,
        reference: { schemaVersion: 1, jobId: '00000000-0000-4000-8000-000000000001' },
      },
      lease: { stop: vi.fn() } as never,
      visibility: { stop: vi.fn() } as never,
      renewal: { release: releaseProtection } as never,
      workerId: 'worker-1',
      store: { release, beginDialSession } as never,
      queue: { delete: deleteHint } as never,
      telephony: { dial } as never,
      options: {
        leaseMs: 60_000, protectionRenewMs: 120_000, deferSeconds: 15,
        visibilitySeconds: 120, workerEndpoint: 'ws://worker.test:4100/internal/media',
        handshakeTtlMs: 60_000,
      },
      recordAttempt: async () => undefined,
      onCarrierAccepted: () => undefined,
      isDraining: () => true,
    });
    expect(result).toEqual({ kind: 'deferred', reason: 'worker-draining' });
    expect(release).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001', 'worker-1', 1, 'worker-draining', expect.any(Date),
    );
    expect(events).toEqual(['release', 'delete', 'protection']);
    expect(beginDialSession).not.toHaveBeenCalled();
    expect(dial).not.toHaveBeenCalled();
  });
});

describe.skipIf(!process.env.OVO_TEST_POSTGRES_URL)('durable carrier reconciliation deferral', () => {
  const schema = `o1_reconcile_${randomUUID().replaceAll('-', '')}`;
  let admin: PostgresOrchestrationStore;
  let store: PostgresOrchestrationStore;

  beforeAll(async () => {
    admin = new PostgresOrchestrationStore({ connectionString: process.env.OVO_TEST_POSTGRES_URL });
    await admin.pool.query(`CREATE SCHEMA ${schema}`);
    store = new PostgresOrchestrationStore({
      connectionString: process.env.OVO_TEST_POSTGRES_URL,
      options: `-c search_path=${schema}`,
    });
    await store.migrate();
    // Removed when the separately reviewed hint migration joins this branch.
    await store.pool.query('ALTER TABLE ovo_jobs ADD COLUMN IF NOT EXISTS hinted_at timestamptz');
    await store.pool.query('ALTER TABLE ovo_jobs ADD COLUMN IF NOT EXISTS hint_count int NOT NULL DEFAULT 0');
  });

  afterAll(async () => {
    await store?.close();
    if (admin) {
      await admin.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.close();
    }
  });

  async function claimedReconciliation() {
    const id = randomUUID();
    await store.enqueue({ id, workspaceId: schema, idempotencyKey: id, payload: {} });
    const owned = await store.claim(id, 'worker-1', 60_000);
    if (owned.kind !== 'execute') throw new Error('expected owned job');
    const requestId = `${id}:1`;
    await store.pool.query(
      `UPDATE ovo_jobs SET status = 'reconcile_required', dial_request_id = $2,
         lease_expires_at = now() - interval '1 second', hinted_at = now()
       WHERE id = $1`, [id, requestId],
    );
    const reclaimed = await store.claim(id, 'worker-1', 60_000);
    if (reclaimed.kind !== 'reconcile') throw new Error('expected reconciliation claim');
    return reclaimed.job;
  }

  it('persists future due time and clears hinted_at before deleting the SQS receipt', async () => {
    const claimed = await claimedReconciliation();
    const deleteHint = vi.fn(async () => {
      const row = (await store.pool.query(
        'SELECT owner_id, hinted_at, not_before FROM ovo_jobs WHERE id = $1', [claimed.id],
      )).rows[0];
      expect(row.owner_id).toBeNull();
      expect(row.hinted_at).toBeNull();
      expect(row.not_before.getTime()).toBeGreaterThan(Date.now());
    });
    const result = await reconcileClaimedCarrierDial({
      workerId: 'worker-1', job: claimed,
      delivery: { messageId: 'hint', receiptHandle: 'receipt', receiveCount: 1,
        reference: { schemaVersion: 1, jobId: claimed.id } },
      store, queue: { delete: deleteHint } as never,
      carriers: { forJob: async () => { throw new Error('carrier config offline'); } } as never,
      deferSeconds: 15,
    });
    expect(result).toEqual({ kind: 'deferred', reason: 'carrier-reconciliation-unavailable:carrier config offline' });
    expect(deleteHint).toHaveBeenCalledOnce();
  });

  it('leaves the receipt available when the claimed epoch was superseded', async () => {
    const claimed = await claimedReconciliation();
    await store.pool.query('UPDATE ovo_jobs SET owner_epoch = owner_epoch + 1 WHERE id = $1', [claimed.id]);
    const deleteHint = vi.fn();
    const result = await reconcileClaimedCarrierDial({
      workerId: 'worker-1', job: claimed,
      delivery: { messageId: 'hint', receiptHandle: 'receipt', receiveCount: 1,
        reference: { schemaVersion: 1, jobId: claimed.id } },
      store, queue: { delete: deleteHint } as never,
      carriers: { forJob: async () => { throw new Error('carrier config offline'); } } as never,
      deferSeconds: 15,
    });
    expect(result).toEqual({ kind: 'deferred', reason: 'reconciliation-ownership-lost' });
    expect(deleteHint).not.toHaveBeenCalled();
  });
});
