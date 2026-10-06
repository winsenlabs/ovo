import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  callingWindowState,
  PostgresOperationsService,
  resolveCallingWindow,
  type CallingWindow,
  type CampaignConfig,
  type CampaignContactInput,
} from '../src/index.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
const SCHEMA = {
  type: 'object',
  required: ['name', 'amountDue'],
  properties: { name: { type: 'string', minLength: 1 }, amountDue: { type: 'string' } },
  additionalProperties: false,
};

/** A window that is open (or closed) for the whole test run, whatever the wall clock says. */
function window(open: boolean): CallingWindow {
  const now = new Date();
  const days = [((now.getUTCDay() + 6) % 7) + 1];
  const always = resolveCallingWindow({ start: '00:00', end: '23:59', days }, 'UTC');
  if (open) {
    // 23:59 itself is outside an exclusive end; the test never runs in that minute.
    expect(callingWindowState(always, now).open).toBe(true);
    return always;
  }
  const otherDays = [1, 2, 3, 4, 5, 6, 7].filter((day) => day !== days[0]);
  return resolveCallingWindow({ start: '00:00', end: '23:59', days: otherDays }, 'UTC');
}

describe.skipIf(!postgresUrl)('outbound compliance in PostgreSQL', () => {
  const organizationId = `compliance-org-${randomUUID()}`;
  let service: PostgresOperationsService;

  const config = (overrides: Partial<CampaignConfig> = {}): CampaignConfig => ({
    operationId: `campaign-${randomUUID()}`,
    name: 'Compliance fixture',
    agentReleaseId: 'release-1',
    fromNumber: '+14155550000',
    schedule: { localDateTime: '2026-01-15T12:00', timezone: 'UTC' },
    perNumberAttemptLimit: 2,
    maxAttemptsTotal: 20,
    maxAttemptsPerLocalDay: 20,
    activeCallPolicy: 'continue',
    maxConcurrency: 10,
    ...overrides,
  });
  const contact = (
    sourceRow: number,
    phoneNumber: string,
    variables: Record<string, string> = { name: 'Asha', amountDue: '1200' },
  ): CampaignContactInput => ({ sourceRow, phoneNumber, variables });

  beforeAll(async () => {
    service = new PostgresOperationsService({ connectionString: postgresUrl, organizationId });
    await service.migrate();
  });

  afterAll(async () => {
    if (!service) return;
    await service.pool.query(
      `DELETE FROM ovo_ops_outbox WHERE payload->>'campaignId' IN
       (SELECT id::text FROM ovo_ops_campaigns WHERE organization_id = $1)`,
      [organizationId],
    );
    await service.pool.query('DELETE FROM ovo_ops_campaigns WHERE organization_id = $1', [
      organizationId,
    ]);
    await service.pool.query('DELETE FROM ovo_ops_suppressions WHERE organization_id = $1', [
      organizationId,
    ]);
    await service.close();
  });

  it('admits nothing outside the calling window and reports when it opens', async () => {
    const closed = window(false);
    const campaign = await service.campaigns.create(config({ callingWindow: closed }), [
      contact(2, '+14155551001'),
    ]);
    expect(campaign.callingWindow).toEqual(closed);
    const admission = await service.campaigns.admit(campaign.id, 'driver', 60_000);
    expect(admission.kind).toBe('outside_calling_hours');
    if (admission.kind !== 'outside_calling_hours') return;
    expect(admission.nextOpenAt.getTime()).toBeGreaterThan(Date.now());
    const open = await service.campaigns.create(config({ callingWindow: window(true) }), [
      contact(2, '+14155551002'),
    ]);
    expect((await service.campaigns.admit(open.id, 'driver', 60_000)).kind).toBe('admitted');
  });

  it('requeues an admitted contact until the window opens when authorization is late', async () => {
    const campaign = await service.campaigns.create(config({ callingWindow: window(true) }), [
      contact(2, '+14155551003'),
    ]);
    const admission = await service.campaigns.admit(campaign.id, 'driver', 60_000);
    if (admission.kind !== 'admitted') throw new Error('expected admission');
    // The window closes between admission and the worker's authorization.
    await service.pool.query('UPDATE ovo_ops_campaigns SET calling_window = $2 WHERE id = $1', [
      campaign.id,
      JSON.stringify(window(false)),
    ]);
    await expect(
      service.campaigns.authorizeDial(admission.contactId, 'driver', admission.ownerEpoch),
    ).resolves.toEqual({ kind: 'blocked', reason: 'outside_calling_hours' });
    const row = await service.pool.query<{ state: string; not_before: Date; owner_id: null }>(
      'SELECT state, not_before, owner_id FROM ovo_ops_campaign_contacts WHERE id = $1',
      [admission.contactId],
    );
    expect(row.rows[0]).toMatchObject({ state: 'queued', owner_id: null });
    expect(row.rows[0]!.not_before.getTime()).toBeGreaterThan(Date.now());
    const attempts = await service.pool.query(
      'SELECT 1 FROM ovo_ops_attempts WHERE contact_id = $1',
      [admission.contactId],
    );
    expect(attempts.rowCount).toBe(0);
  });

  it('marks a contact invalid at admission when its variables fail the release schema', async () => {
    const campaign = await service.campaigns.create(config({ variablesSchema: SCHEMA }), [
      contact(2, '+14155551004', { name: 'Ravi' }),
      contact(3, '+14155551005'),
    ]);
    const admission = await service.campaigns.admit(campaign.id, 'driver', 60_000);
    if (admission.kind !== 'admitted') throw new Error('expected admission');
    const contacts = await service.campaigns.listContacts(campaign.id);
    expect(contacts.map((row) => [row.phoneNumber, row.state])).toEqual([
      ['+14155551004', 'invalid'],
      ['+14155551005', 'admitted'],
    ]);
    expect(admission.contactId).toBe(contacts[1]!.id);
    expect((await service.campaigns.counters(campaign.id)).contacts.invalid).toBe(1);
  });

  it('keeps legacy campaign digests stable when no window is configured', async () => {
    const shared = config({ variablesSchema: SCHEMA });
    const first = await service.campaigns.create(shared, [contact(2, '+14155551006')]);
    // A retry computes the same digest even though the schema came from a later release read.
    const retry = await service.campaigns.create({ ...shared, variablesSchema: null }, [
      contact(2, '+14155551006'),
    ]);
    expect(retry.id).toBe(first.id);
    await expect(
      service.campaigns.create({ ...shared, callingWindow: window(true) }, [
        contact(2, '+14155551006'),
      ]),
    ).rejects.toThrow('operationId collision');
  });

  it('keeps the do-not-call list with its source and never downgrades an opt-out', async () => {
    const dnc = service.campaigns.doNotCall;
    await dnc.add('+14155552001', 'Caller asked to stop', { source: 'opt_out', callId: 'call-1' });
    expect(await dnc.import([{ phoneNumber: '+1 415 555 2001', reason: 'Bulk list' }])).toEqual({
      added: 0,
      updated: 1,
    });
    expect(await dnc.get('+14155552001')).toMatchObject({
      source: 'opt_out',
      callId: 'call-1',
      reason: 'Caller asked to stop',
    });
    expect(
      await dnc.import([
        { phoneNumber: '+14155552002', reason: 'Registry' },
        { phoneNumber: '+14155552002', reason: 'Registry duplicate' },
        { phoneNumber: '+14155552003', reason: 'Registry' },
      ]),
    ).toEqual({ added: 2, updated: 0 });
    expect(await dnc.listed(['+14155552002', '+14155559999', 'not a number'])).toEqual(
      new Set(['+14155552002']),
    );
    const listed = await service.campaigns.listSuppressions(100);
    expect(listed.find((row) => row.phoneNumber === '+14155552003')).toMatchObject({
      source: 'import',
    });
    await expect(dnc.import([])).rejects.toThrow('1 to 1000');
  });

  it('never admits or authorizes a number added to the do-not-call list', async () => {
    const campaign = await service.campaigns.create(config(), [
      contact(2, '+14155553001'),
      contact(3, '+14155553002'),
    ]);
    await service.campaigns.doNotCall.add('+14155553001', 'Opted out', { source: 'opt_out' });
    const admission = await service.campaigns.admit(campaign.id, 'driver', 60_000);
    if (admission.kind !== 'admitted') throw new Error('expected admission');
    const contacts = await service.campaigns.listContacts(campaign.id);
    expect(admission.contactId).toBe(contacts[1]!.id);
    await service.campaigns.doNotCall.add('+14155553002', 'Opted out mid-dial');
    await expect(
      service.campaigns.authorizeDial(admission.contactId, 'driver', admission.ownerEpoch),
    ).resolves.toEqual({ kind: 'blocked', reason: 'suppressed' });
  });
});
