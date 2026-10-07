import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ComplianceSettingsConflict,
  ComplianceSettingsInvalid,
  ConsentRejected,
  DoNotCallLockedError,
} from '../../src/index.ts';
import { complianceWorkspace, mobile } from './fixture.ts';
import { unzip } from './unzip.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
const DAY = 86_400_000;

describe.skipIf(!postgresUrl)('compliance records in PostgreSQL', () => {
  let workspace: Awaited<ReturnType<typeof complianceWorkspace>>;
  beforeAll(async () => {
    workspace = await complianceWorkspace();
  });
  afterAll(() => workspace?.close());

  it('locks an in-call opt-out for 90 days and revokes the consents it covers (R13)', async () => {
    const { service } = workspace;
    const number = mobile();
    const consent = await service.compliance.consents.record({
      phoneNumber: number,
      principalEntity: 'Example Bank',
      purpose: 'loan servicing',
      category: 'service',
      basis: 'explicit_service_7d',
      evidenceRef: 'CRF-1',
      obtainedAt: new Date(Date.now() - DAY),
    });
    expect(consent.expiresAt!.getTime() - consent.obtainedAt.getTime()).toBe(7 * DAY);
    await service.campaigns.doNotCall.add(number, 'Caller asked not to be called again', {
      source: 'opt_out',
      callId: 'call-1',
    });
    const listed = await service.campaigns.doNotCall.get(number);
    expect(listed).toMatchObject({ source: 'opt_out', scope: 'all', callId: 'call-1' });
    expect(Math.abs(listed!.lockUntil!.getTime() - Date.now() - 90 * DAY)).toBeLessThan(60_000);
    expect((await service.compliance.consents.list(number))[0]).toMatchObject({
      revocationSource: 'in_call_opt_out',
      revocationRef: 'call-1',
    });
    await expect(service.campaigns.doNotCall.remove(number)).rejects.toBeInstanceOf(
      DoNotCallLockedError,
    );
    // A bulk import never downgrades the caller's own opt-out (existing behaviour).
    await service.campaigns.doNotCall.import([{ phoneNumber: number, reason: 'Registry' }]);
    expect(await service.campaigns.doNotCall.get(number)).toMatchObject({ source: 'opt_out' });
    // Consent may not be sought again inside the 90 days, unless the customer opts in themselves.
    const again = {
      phoneNumber: number,
      principalEntity: 'Example Bank',
      purpose: 'loan servicing',
      category: 'service' as const,
      basis: 'explicit_service_7d' as const,
      evidenceRef: 'CRF-2',
      obtainedAt: new Date(),
    };
    await expect(service.compliance.consents.record(again)).rejects.toMatchObject({
      code: 'opt_out_locked',
    });
    await expect(
      service.compliance.consents.record({ ...again, customerInitiated: true }),
    ).resolves.toMatchObject({ customerInitiated: true });
    // An operator entry has no lock and can be removed.
    const manual = mobile();
    await service.campaigns.doNotCall.add(manual, 'Operator');
    await expect(service.campaigns.doNotCall.remove(manual)).resolves.toMatchObject({
      source: 'manual',
    });
  });

  it('refuses consent without evidence or from the future', async () => {
    const consent = {
      phoneNumber: mobile(),
      principalEntity: 'Example Bank',
      purpose: 'offers',
      category: 'promotional' as const,
      basis: 'inquiry_7d' as const,
      evidenceRef: ' ',
      obtainedAt: new Date(),
    };
    await expect(workspace.service.compliance.consents.record(consent)).rejects.toBeInstanceOf(
      ConsentRejected,
    );
    await expect(
      workspace.service.compliance.consents.record({
        ...consent,
        evidenceRef: 'INQ-1',
        obtainedAt: new Date(Date.now() + DAY),
      }),
    ).rejects.toMatchObject({ code: 'invalid_consent' });
  });

  it('backs off a busy number and never retries after a do-not-call disposition', async () => {
    const { service, campaign, dial, contactRow } = workspace;
    const created = await campaign([mobile()]);
    const busy = await dial(created.id);
    await service.campaigns.recordAttempt(
      busy.attemptId,
      `busy-${busy.attemptId}`,
      'failed',
      new Date(),
      'busy',
    );
    const retried = await contactRow(busy.contactId);
    expect(retried).toMatchObject({ state: 'queued', compliance_reason: 'retry_backoff' });
    expect(retried.not_before.getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(retried.not_before.getTime() - Date.now()).toBeLessThan(31 * 60_000);

    const answered = await campaign([mobile()]);
    const call = await dial(answered.id);
    await service.campaigns.recordAttempt(
      call.attemptId,
      `c-${call.attemptId}`,
      'connected',
      new Date(),
    );
    await service.campaigns.recordAttempt(
      call.attemptId,
      `s-${call.attemptId}`,
      'succeeded',
      new Date(),
    );
    const ledger = await service.pool.query<{ call_id: string }>(
      'SELECT call_id FROM ovo_ops_recipient_attempts WHERE attempt_id = $1',
      [call.attemptId],
    );
    const callId = ledger.rows[0]!.call_id;
    const applied = await service.compliance.applyDispositions(
      async (ids) =>
        new Map(ids.filter((id) => id === callId).map((id) => [id, 'do_not_call_requested'])),
      new Date(Date.now() + 11 * 60_000),
    );
    expect(applied).toBeGreaterThanOrEqual(1);
    expect(await service.campaigns.doNotCall.get(call.to)).toMatchObject({ source: 'opt_out' });

    // A redrive never follows a refusal, and is never queued before the number is eligible.
    await service.pool.query(
      `UPDATE ovo_ops_campaign_contacts SET state = 'failed' WHERE id = $1`,
      [busy.contactId],
    );
    const outcome = (value: string) =>
      service.pool.query(
        'UPDATE ovo_ops_recipient_attempts SET outcome = $2 WHERE attempt_id = $1',
        [busy.attemptId, value],
      );
    await outcome('refused');
    expect(await service.retries.redrive(busy.contactId, new Date())).toEqual({
      kind: 'blocked',
      reason: 'outcome_no_retry',
    });
    await outcome('busy');
    const current = await service.compliance.settings.get();
    await service.compliance.settings.put(
      { ...current.settings, caps: { service: { minGapMinutes: 120 } } },
      current.version,
    );
    try {
      const queued = await service.retries.redrive(busy.contactId, new Date());
      expect(queued.kind).toBe('queued');
      if (queued.kind !== 'queued') return;
      expect(queued.notBefore!.getTime() - Date.now()).toBeGreaterThan(115 * 60_000);
    } finally {
      await service.compliance.settings.put(current.settings, current.version + 1);
    }
  });

  it('suppresses a wrong number for its purpose and opens a complaint for a dispute', async () => {
    const { service, campaign, dial } = workspace;
    const policy = {
      version: 1 as const,
      category: 'service' as const,
      purpose: 'reminder' as const,
    };
    const wrong = await dial((await campaign([mobile()], policy)).id);
    const disputed = await dial((await campaign([mobile()], policy)).id);
    for (const attempt of [wrong, disputed])
      await service.campaigns.recordAttempt(
        attempt.attemptId,
        `e-${attempt.attemptId}`,
        'succeeded',
        new Date(),
      );
    const calls = await service.pool.query<{ call_id: string; attempt_id: string }>(
      'SELECT call_id, attempt_id FROM ovo_ops_recipient_attempts WHERE attempt_id = ANY($1::uuid[])',
      [[wrong.attemptId, disputed.attemptId]],
    );
    const disposition = new Map(
      calls.rows.map((row) => [
        row.call_id,
        row.attempt_id === wrong.attemptId ? 'wrong_number' : 'dispute_raised',
      ]),
    );
    await service.compliance.applyDispositions(async () => disposition);
    expect(await service.campaigns.doNotCall.get(wrong.to)).toMatchObject({
      source: 'wrong_number',
      scope: 'purpose',
      purpose: 'reminder',
    });
    const complaints = await service.compliance.complaints.list();
    expect(complaints.find((row) => row.phoneNumber === disputed.to)).toMatchObject({
      kind: 'customer',
      channel: 'in_call',
      status: 'open',
    });
    const next = await campaign([disputed.to], policy);
    expect((await service.campaigns.admit(next.id, 'driver', 60_000)).kind).toBe('empty');
    expect((await service.compliance.decisions({ campaignId: next.id }))[0]).toMatchObject({
      verdict: 'refuse',
      reason: 'complaint_open',
    });
  });

  it('times complaints against their SLA and keeps an action trail (R21)', async () => {
    const { service } = workspace;
    const receivedAt = new Date('2026-10-02T06:30:00Z'); // Friday noon IST
    const customer = await service.compliance.openComplaint({
      kind: 'customer',
      phoneNumber: mobile(),
      receivedAt,
      channel: 'email',
    });
    expect(customer.ackDueAt).toEqual(new Date(receivedAt.getTime() + DAY));
    expect(customer.resolveDueAt).toEqual(new Date(receivedAt.getTime() + 7 * DAY));
    expect(customer.overdue).toBe('ack');
    expect(await service.campaigns.doNotCall.get(customer.phoneNumber!)).toMatchObject({
      source: 'complaint',
    });
    const notice = await service.compliance.openComplaint({
      kind: 'oap_notice',
      cli: '+911600123456',
      receivedAt,
      oapRef: 'UCC/2026/9',
    });
    // Five business days from a Friday is the next Friday.
    expect(notice.resolveDueAt).toEqual(new Date('2026-10-09T06:30:00Z'));
    const acknowledged = await service.compliance.complaints.transition(
      customer.id,
      'acknowledged',
    );
    expect(acknowledged).toMatchObject({
      status: 'acknowledged',
      acknowledgedAt: expect.any(Date),
    });
    const resolved = await service.compliance.complaints.transition(
      customer.id,
      'resolved',
      'Apologised',
    );
    expect(resolved).toMatchObject({ resolution: 'Apologised' });
    expect(await service.compliance.complaints.transition(customer.id, 'acknowledged')).toBe(
      'invalid_transition',
    );
    if (resolved === 'invalid_transition') throw new Error('expected a complaint');
    expect(resolved.actions.map((action) => action.action)).toEqual([
      'opened',
      'acknowledged',
      'resolved',
    ]);
  });

  it('versions settings and refuses a change that would widen a floor', async () => {
    const { service } = workspace;
    const current = await service.compliance.settings.get();
    await expect(
      service.compliance.settings.put(current.settings, current.version - 1),
    ).rejects.toBeInstanceOf(ComplianceSettingsConflict);
    await expect(
      service.compliance.settings.put(
        {
          ...current.settings,
          windows: { promotional: { rules: [{ start: '09:00', end: '21:00' }] } },
        },
        current.version,
      ),
    ).rejects.toBeInstanceOf(ComplianceSettingsInvalid);
    expect((await service.compliance.settings.get()).version).toBe(current.version);
  });

  it('exports every decision with a manifest whose hashes match the files (spec 3.8)', async () => {
    const { service, campaign, dial } = workspace;
    const from = new Date(Date.now() - 60_000);
    const attempt = await dial((await campaign([mobile()])).id);
    const { zip, manifest } = await service.compliance.export({
      from,
      to: new Date(Date.now() + 60_000),
    });
    const files = unzip(zip);
    const listed = manifest.files as Array<{ name: string; sha256: string }>;
    for (const file of listed)
      expect(createHash('sha256').update(files.get(file.name)!).digest('hex')).toBe(file.sha256);
    expect(JSON.parse(files.get('manifest.json')!.toString())).toMatchObject({
      rulePack: 'IN-TCCCPR@2026.10.1',
      policyHashes: expect.arrayContaining([expect.any(String)]),
    });
    expect(files.get('decisions.csv')!.toString()).toContain(attempt.attemptId);
    expect(files.get('attempts.csv')!.toString()).toContain(`${attempt.attemptId},${attempt.to}`);
    const packet = await service.compliance.evidence(attempt.to, new Date());
    expect(packet).toMatchObject({ phoneNumber: attempt.to, attempts: [expect.anything()] });
  });
});
