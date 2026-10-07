import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { complianceWorkspace, FROM_1600, mobile, SERVICE } from './fixture.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
const HOUR = 3_600_000;

describe.skipIf(!postgresUrl)('the compliance gate on the dial path (PostgreSQL)', () => {
  let workspace: Awaited<ReturnType<typeof complianceWorkspace>>;

  beforeAll(async () => {
    workspace = await complianceWorkspace({
      caps: { service: { attempts: { per24h: 3 }, minGapMinutes: 0 } },
    });
  });
  afterAll(() => workspace?.close());

  it('caps attempts per number across campaigns on a rolling 24 hours (G9)', async () => {
    const { campaign, dial, admit, authorize, contactRow, service } = workspace;
    const number = mobile();
    const campaigns = await Promise.all([1, 2, 3, 4].map(() => campaign([number])));
    const first = await dial(campaigns[0]!.id);
    // Three more campaigns admit the number while the ledger holds one attempt.
    const admitted = [];
    for (const later of campaigns.slice(1)) admitted.push(await admit(later.id));
    expect((await authorize(admitted[0]!)).kind).toBe('authorized');
    expect((await authorize(admitted[1]!)).kind).toBe('authorized');
    // The fourth attempt in 24 hours is refused at the final gate and waits for the first to age.
    expect(await authorize(admitted[2]!)).toEqual({
      kind: 'blocked',
      reason: 'recipient_attempt_cap',
    });
    const authorizedAt = (
      await service.pool.query<{ authorized_at: Date }>(
        'SELECT authorized_at FROM ovo_ops_recipient_attempts WHERE attempt_id = $1',
        [first.attemptId],
      )
    ).rows[0]!.authorized_at;
    const waiting = await contactRow(admitted[2]!.contactId);
    expect(waiting).toMatchObject({ state: 'queued', compliance_reason: 'recipient_attempt_cap' });
    expect(waiting.not_before.getTime()).toBe(authorizedAt.getTime() + 24 * HOUR);
    // Admission now defers it too, instead of admitting it again.
    expect((await service.campaigns.admit(campaigns[3]!.id, 'driver', 60_000)).kind).toBe('empty');
  });

  it('writes the decision, the ledger row and the attempt in one transaction', async () => {
    const { campaign, dial, admit, authorize, service, organizationId } = workspace;
    const created = await campaign([mobile()]);
    const authorization = await dial(created.id);
    const decision = await service.pool.query(
      `SELECT stage, verdict, rule_pack, policy_hash FROM ovo_ops_compliance_decisions
       WHERE organization_id = $1 AND attempt_id = $2`,
      [organizationId, authorization.attemptId],
    );
    expect(decision.rows).toEqual([
      expect.objectContaining({
        stage: 'authorize',
        verdict: 'allow',
        rule_pack: 'IN-TCCCPR@2026.10.1',
      }),
    ]);
    const ledger = await service.pool.query(
      'SELECT call_id, from_number, category FROM ovo_ops_recipient_attempts WHERE attempt_id = $1',
      [authorization.attemptId],
    );
    expect(ledger.rows[0]).toMatchObject({ from_number: FROM_1600, category: 'service' });
    expect(ledger.rows[0].call_id).toEqual(expect.any(String));

    // A failure while writing the ledger rolls the attempt and the decision back with it.
    const doomed = mobile();
    const failing = await campaign([doomed]);
    const admission = await admit(failing.id);
    await service.pool
      .query(`CREATE OR REPLACE FUNCTION ovo_test_ledger_fail() RETURNS trigger AS $$
      BEGIN IF NEW.phone_number = '${doomed}' THEN RAISE EXCEPTION 'ledger write failed'; END IF;
      RETURN NEW; END $$ LANGUAGE plpgsql`);
    await service.pool
      .query(`CREATE TRIGGER ovo_test_ledger_fail BEFORE INSERT ON ovo_ops_recipient_attempts
      FOR EACH ROW EXECUTE FUNCTION ovo_test_ledger_fail()`);
    try {
      await expect(authorize(admission)).rejects.toThrow('ledger write failed');
    } finally {
      await service.pool.query('DROP TRIGGER ovo_test_ledger_fail ON ovo_ops_recipient_attempts');
      await service.pool.query('DROP FUNCTION ovo_test_ledger_fail()');
    }
    const left = await service.pool.query(
      `SELECT (SELECT count(*) FROM ovo_ops_attempts WHERE contact_id = $1)::int AS attempts,
         (SELECT count(*) FROM ovo_ops_compliance_decisions WHERE contact_id = $1
           AND stage = 'authorize')::int AS decisions,
         (SELECT count(*) FROM ovo_ops_recipient_attempts WHERE contact_id = $1)::int AS ledger`,
      [admission.contactId],
    );
    expect(left.rows[0]).toEqual({ attempts: 0, decisions: 0, ledger: 0 });
  });

  it('never dials a number that opts out while its call is being authorized', async () => {
    const { campaign, admit, authorize, service, organizationId } = workspace;
    const number = mobile();
    const admission = await admit((await campaign([number])).id);
    // The opt-out holds the per-number lock; authorization waits for it, then sees the entry.
    const blocker = await service.pool.connect();
    try {
      await blocker.query('BEGIN');
      await service.campaigns.doNotCall.upsert(blocker, number, 'Stop calling me', 'opt_out', {});
      const pending = authorize(admission);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await blocker.query('COMMIT');
      expect(await pending).toEqual({ kind: 'blocked', reason: 'suppressed' });
    } finally {
      blocker.release();
    }
    const attempts = await service.pool.query(
      `SELECT 1 FROM ovo_ops_recipient_attempts WHERE organization_id = $1 AND phone_number = $2`,
      [organizationId, number],
    );
    expect(attempts.rowCount).toBe(0);
  });

  it('pauses a campaign whose agent has no category instead of dialing +91 numbers', async () => {
    const { campaign, service } = workspace;
    const created = await campaign([mobile()], { version: 1 });
    const admission = await service.campaigns.admit(created.id, 'driver', 60_000);
    expect(admission).toEqual({ kind: 'compliance_paused', reason: 'category_missing' });
    expect(await service.campaigns.get(created.id)).toMatchObject({
      status: 'paused',
      driverError: 'compliance:category_missing',
    });
  });

  it('pauses campaigns on a caller number whose abandoned ratio crosses 3% (R18)', async () => {
    const { campaign, service, organizationId } = workspace;
    const from = '+911600654321';
    await service.compliance.cli.upsert({ phoneNumber: from, categories: ['service'] });
    // 1 abandoned in 30 answered attempts over the last 24 hours: 3.3%.
    await service.pool.query(
      `INSERT INTO ovo_ops_recipient_attempts (organization_id, attempt_id, phone_number,
         from_number, authorized_at, connected_at, ended_at, outcome)
       SELECT $1, gen_random_uuid(), '+9197' || lpad(n::text, 8, '0'), $2, now() - interval '1 hour',
         now() - interval '59 minutes', now() - interval '50 minutes',
         CASE WHEN n = 1 THEN 'abandoned' ELSE 'connected' END
       FROM generate_series(1, 30) AS n`,
      [organizationId, from],
    );
    expect(
      (await service.compliance.ratios()).find((row) => row.fromNumber === from),
    ).toMatchObject({
      attempts: 30,
      abandoned: 1,
      level: 'stop',
    });
    const created = await campaign([mobile()], SERVICE, { fromNumber: from });
    expect(await service.campaigns.admit(created.id, 'driver', 60_000)).toEqual({
      kind: 'compliance_paused',
      reason: 'abandoned_ratio_breaker',
    });
    // In monitor mode the ratio is reported and the campaign dials.
    const current = await service.compliance.settings.get();
    await service.compliance.settings.put(
      {
        ...current.settings,
        enforcement: { ...current.settings.enforcement, abandonedBreaker: 'monitor' },
      },
      current.version,
    );
    const monitored = await campaign([mobile()], SERVICE, { fromNumber: from });
    expect((await service.campaigns.admit(monitored.id, 'driver', 60_000)).kind).toBe('admitted');
    await service.compliance.settings.put(current.settings, current.version + 1);
  });

  it('refuses a caller number outside the designated series, and dials it in warn mode', async () => {
    const { campaign, service } = workspace;
    const from = '+919800000123';
    await service.compliance.cli.upsert({ phoneNumber: from, categories: ['service'] });
    const refused = await campaign([mobile()], SERVICE, { fromNumber: from });
    expect(await service.campaigns.admit(refused.id, 'driver', 60_000)).toEqual({
      kind: 'compliance_paused',
      reason: 'series_category_mismatch',
    });
    const current = await service.compliance.settings.get();
    await service.compliance.settings.put(
      { ...current.settings, enforcement: { ...current.settings.enforcement, series: 'warn' } },
      current.version,
    );
    try {
      const warned = await campaign([mobile()], SERVICE, { fromNumber: from });
      const admission = await service.campaigns.admit(warned.id, 'driver', 60_000);
      expect(admission.kind).toBe('admitted');
      const decision = await service.compliance.decisions({ campaignId: warned.id });
      expect(decision[0]).toMatchObject({
        verdict: 'allow',
        warnings: ['series_category_mismatch'],
      });
    } finally {
      await service.compliance.settings.put(current.settings, current.version + 1);
    }
  });
});
