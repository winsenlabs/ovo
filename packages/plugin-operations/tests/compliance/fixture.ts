import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import {
  PostgresOperationsService,
  type CampaignConfig,
  type CompliancePolicy,
} from '../../src/index.ts';

export const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
/** A 1600-series service number (R3) and a 10-digit mobile that belongs to no designated series. */
export const FROM_1600 = '+911600123456';
export const FROM_MOBILE = '+919800000999';
export const ALL_DAY = { rules: [{ start: '00:00', end: '23:59' }] };
export const INTIMATION = {
  submittedAt: '2026-09-01',
  oap: 'Example telco',
  objective: 'EMI reminders by an AI agent',
  documentRef: 'OAP/2026/17',
};
export const SERVICE: CompliancePolicy = { version: 1, category: 'service' };

const TABLES = [
  'ovo_ops_compliance_decisions',
  'ovo_ops_recipient_attempts',
  'ovo_ops_consents',
  'ovo_ops_preference_checks',
  'ovo_ops_complaints',
  'ovo_ops_cli_numbers',
  'ovo_ops_a2p_declarations',
  'ovo_ops_compliance_settings',
  'ovo_ops_suppressions',
];

/**
 * A workspace configured for India: the autodialler intimation on file, a registered 1600 caller
 * number, and service windows open all day so the tests do not depend on the wall clock.
 */
export async function complianceWorkspace(settings: Record<string, unknown> = {}) {
  const organizationId = `compliance-${randomUUID()}`;
  const service = new PostgresOperationsService({
    connectionString: postgresUrl,
    organizationId,
    config: { permittedFromNumbers: [FROM_1600, FROM_MOBILE], liveEnabled: true },
  });
  await service.migrate();
  await service.compliance.settings.put(
    {
      autodialerIntimation: INTIMATION,
      windows: { service: ALL_DAY, generic: ALL_DAY },
      caps: { service: { minGapMinutes: 0 } },
      ...settings,
    },
    0,
  );
  await service.compliance.cli.upsert({
    phoneNumber: FROM_1600,
    categories: ['service', 'transactional'],
  });

  const campaign = (
    phoneNumbers: string[],
    policy: CompliancePolicy | null = SERVICE,
    overrides: Partial<CampaignConfig> = {},
  ) =>
    service.campaigns.create(
      {
        operationId: randomUUID(),
        name: 'India compliance',
        agentReleaseId: 'release-1',
        fromNumber: FROM_1600,
        schedule: { localDateTime: '2026-01-15T12:00', timezone: 'Asia/Kolkata' },
        perNumberAttemptLimit: 3,
        maxAttemptsTotal: 100,
        maxAttemptsPerLocalDay: 100,
        activeCallPolicy: 'continue',
        maxConcurrency: 10,
        compliance: policy,
        ...overrides,
      },
      phoneNumbers.map((phoneNumber, index) => ({
        sourceRow: index + 2,
        phoneNumber,
        variables: {},
      })),
    );

  const admit = async (campaignId: string) => {
    const admission = await service.campaigns.admit(campaignId, 'driver', 60_000);
    if (admission.kind !== 'admitted') throw new Error(`expected admission, got ${admission.kind}`);
    return admission;
  };
  const authorize = (admission: { contactId: string; ownerEpoch: number }) =>
    service.campaigns.authorizeDial(admission.contactId, 'driver', admission.ownerEpoch);
  /** Admits and authorizes the campaign's next contact; the authorization must succeed. */
  const dial = async (campaignId: string) => {
    const authorization = await authorize(await admit(campaignId));
    expect(authorization.kind).toBe('authorized');
    if (authorization.kind !== 'authorized') throw new Error('expected authorization');
    return authorization;
  };
  const contactRow = async (contactId: string) =>
    (
      await service.pool.query<{
        state: string;
        not_before: Date;
        compliance_reason: string | null;
      }>(
        'SELECT state, not_before, compliance_reason FROM ovo_ops_campaign_contacts WHERE id = $1',
        [contactId],
      )
    ).rows[0]!;

  const close = async () => {
    for (const table of TABLES)
      await service.pool.query(`DELETE FROM ${table} WHERE organization_id = $1`, [organizationId]);
    await service.pool.query(
      `DELETE FROM ovo_ops_outbox WHERE payload->>'campaignId' IN
       (SELECT id::text FROM ovo_ops_campaigns WHERE organization_id = $1)`,
      [organizationId],
    );
    await service.pool.query('DELETE FROM ovo_ops_campaigns WHERE organization_id = $1', [
      organizationId,
    ]);
    await service.close();
  };

  return { organizationId, service, campaign, admit, authorize, dial, contactRow, close };
}

/** A fresh Indian mobile number per call, so tests never share a recipient's ledger. */
let counter = 0;
export function mobile(): string {
  counter += 1;
  return `+9198${String(Date.now() % 100_000_000)
    .padStart(8, '0')
    .slice(0, 4)}${String(counter).padStart(4, '0')}`;
}
