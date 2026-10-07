import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { PostgresControlStore, type Role } from '@winsendotai/ovo-plugin-storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerOperationsRoutes } from '../../../apps/api/src/routes/operations.ts';
import { registerCampaignCarrierResolver } from '../../../apps/api/src/operations-plugin.ts';
import { PostgresOperationsService } from '../src/index.ts';
import { apiCarrierFixture } from './api-carrier-fixture.ts';
import { ALL_DAY, FROM_1600, FROM_MOBILE, INTIMATION, mobile } from './compliance/fixture.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
const rank: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };

describe.skipIf(!postgresUrl)('India compliance through the operations API', () => {
  const workspaceId = `india-compliance-${randomUUID()}`;
  const testNumber = '+919811100000';
  let operations: PostgresOperationsService;
  let store: PostgresControlStore;
  let app: ReturnType<typeof Fastify>;
  const releases: Record<'none' | 'service' | 'promotional', string> = {
    none: '',
    service: '',
    promotional: '',
  };

  function requireRole(request: FastifyRequest, expected: Role) {
    const role = String(request.headers['x-test-role'] ?? 'admin') as Role;
    if (!rank[role] || rank[role] < rank[expected])
      throw Object.assign(new Error('Insufficient role'), { statusCode: 403, code: 'forbidden' });
    return { identityId: `operator-${role}`, label: role, workspaceId, role };
  }

  async function release(compliance?: Record<string, unknown>) {
    const agent = await store.createAgent(
      workspaceId,
      AgentConfig.parse({
        name: 'Collections',
        mode: 'announcement',
        message: 'Hello',
        compliance,
      }),
    );
    return (
      await store.createRelease({
        workspaceId,
        agent,
        plugins: [],
        createdBy: 'admin',
        id: randomUUID(),
      })
    ).id;
  }

  const send = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
    role: Role = 'admin',
  ) =>
    app.inject({ method, url, ...(payload ? { payload } : {}), headers: { 'x-test-role': role } });
  const call = (payload: Record<string, unknown>) =>
    send('POST', '/v1/calls', {
      operationId: randomUUID(),
      releaseId: releases.service,
      fromNumber: FROM_1600,
      to: mobile(),
      ...payload,
    });
  const campaign = (releaseId: string, extra: Record<string, unknown> = {}) =>
    send('POST', '/v1/operations/campaigns', {
      operationId: randomUUID(),
      name: 'October reminders',
      releaseId,
      fromNumber: FROM_1600,
      schedule: { localDateTime: '2026-01-15T12:00', timezone: 'Asia/Kolkata' },
      perNumberAttemptLimit: 1,
      maxAttemptsTotal: 10,
      maxAttemptsPerLocalDay: 10,
      activeCallPolicy: 'continue',
      contacts: [{ sourceRow: 2, phoneNumber: mobile(), variables: {} }],
      ...extra,
    });

  beforeAll(async () => {
    operations = new PostgresOperationsService({
      connectionString: postgresUrl,
      organizationId: workspaceId,
      config: { permittedFromNumbers: [FROM_1600, FROM_MOBILE], liveEnabled: true },
    });
    const carrier = apiCarrierFixture();
    registerCampaignCarrierResolver(operations, carrier.catalog, carrier.controls);
    store = await PostgresControlStore.open(postgresUrl!);
    await Promise.all([operations.migrate(), store.ensureWorkspace(workspaceId, 'India')]);
    releases.none = await release();
    releases.service = await release({ category: 'service', purpose: 'reminder' });
    releases.promotional = await release({
      category: 'promotional',
      callingHours: { start: '08:00', end: '19:00' },
    });
    app = Fastify();
    app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
      const typed = error as Error & { statusCode?: number; code?: string };
      reply
        .code(typed.statusCode ?? 400)
        .send({ error: { code: typed.code ?? 'request_error', message: typed.message } });
    });
    registerOperationsRoutes({ app, operations, store, requireRole });
    await app.ready();
    const settings = await send('PUT', '/v1/operations/compliance/settings', {
      expectedVersion: 0,
      settings: {
        autodialerIntimation: INTIMATION,
        windows: { service: ALL_DAY },
        testNumbers: [testNumber],
      },
    });
    expect(settings.statusCode).toBe(200);
    for (const [phone, categories] of [
      [FROM_1600, ['service', 'transactional']],
      [FROM_MOBILE, ['service']],
    ] as const)
      expect(
        (
          await send('PUT', `/v1/operations/compliance/cli-numbers/${encodeURIComponent(phone)}`, {
            categories,
          })
        ).json(),
      ).toMatchObject({ series: phone === FROM_1600 ? '1600' : 'other', status: 'active' });
  });

  afterAll(async () => {
    for (const table of [
      'ovo_ops_suppressions',
      'ovo_ops_compliance_settings',
      'ovo_ops_cli_numbers',
      'ovo_ops_consents',
      'ovo_ops_complaints',
      'ovo_ops_compliance_decisions',
    ])
      await operations?.pool.query(`DELETE FROM ${table} WHERE organization_id = $1`, [
        workspaceId,
      ]);
    await app?.close();
    await operations?.close();
    await store?.close();
  });

  it('refuses a manual +91 call from an agent with no category, except to a test number', async () => {
    const refused = await call({ releaseId: releases.none });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: { code: 'category_missing' } });
    const ownPhone = await call({ releaseId: releases.none, to: testNumber, dryRun: true });
    expect(ownPhone.statusCode).toBe(200);
    expect((await call({ dryRun: true })).statusCode).toBe(200);
    const live = await call({});
    expect(live.statusCode).toBe(202);
    const created = await operations.campaigns.get(live.json().campaignId);
    expect(created.compliance).toMatchObject({
      category: 'service',
      purpose: 'reminder',
      manual: true,
    });
  });

  it('refuses a service call from a number outside the 1600/1601 series (R3, R4)', async () => {
    const refused = await call({ fromNumber: FROM_MOBILE });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: { code: 'series_category_mismatch' } });
    const campaignRefused = await campaign(releases.service, { fromNumber: FROM_MOBILE });
    expect(campaignRefused.json()).toMatchObject({ error: { code: 'series_category_mismatch' } });
  });

  it('checks a campaign against the floors before writing it (E1)', async () => {
    const widened = await campaign(releases.promotional, {
      compliance: { consentBasis: 'preference_allows' },
    });
    expect(widened.statusCode).toBe(422);
    expect(widened.json()).toMatchObject({
      error: { code: 'policy_widens_floor', details: { problems: [{ source: 'agent' }] } },
    });
    const created = await campaign(releases.service);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ complianceReport: { allow: 1 } });
    const preview = await send(
      'POST',
      '/v1/operations/compliance/policy-preview',
      {
        releaseId: releases.promotional,
      },
      'viewer',
    );
    expect(preview.json()).toMatchObject({
      rulePack: 'IN-TCCCPR@2026.10.1',
      layers: [
        {
          source: 'rule_pack',
          timezone: 'Asia/Kolkata',
          rules: [{ start: '10:00', end: '21:00' }],
        },
        { source: 'workspace' },
        { source: 'agent', rules: [{ start: '08:00', end: '19:00' }] },
      ],
      problems: [{ code: 'consent_basis_not_allowed' }, { code: 'policy_widens_floor' }],
    });
  });

  it('keeps an opt-out for 90 days and audits every removal (R13)', async () => {
    const optedOut = mobile();
    await operations.campaigns.doNotCall.add(optedOut, 'Caller asked', { source: 'opt_out' });
    const url = `/v1/operations/suppressions/${encodeURIComponent(optedOut)}`;
    expect(
      (await send('DELETE', `${url}?reason=renewed%20consent`, undefined, 'editor')).statusCode,
    ).toBe(403);
    expect((await send('DELETE', url)).statusCode).toBe(400);
    const locked = await send('DELETE', `${url}?reason=renewed%20consent`);
    expect(locked.statusCode).toBe(409);
    expect(locked.json()).toMatchObject({
      error: { code: 'opt_out_locked', details: { lockUntil: expect.any(String) } },
    });
    const manual = mobile();
    await operations.campaigns.doNotCall.add(manual, 'Operator');
    const removed = await send(
      'DELETE',
      `/v1/operations/suppressions/${encodeURIComponent(manual)}?reason=added%20by%20mistake`,
    );
    expect(removed.statusCode).toBe(204);
    const actions = (await store.listAudit(workspaceId, 100)).items;
    expect(actions.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        'operations.suppression.delete_refused',
        'operations.suppression.delete',
      ]),
    );
    expect(JSON.stringify(actions)).not.toContain(manual.slice(1));
  });

  it('records consent, complaints and settings through the compliance routes', async () => {
    const stale = await send('PUT', '/v1/operations/compliance/settings', {
      expectedVersion: 0,
      settings: {},
    });
    expect(stale.statusCode).toBe(409);
    const number = mobile();
    const consent = await send(
      'POST',
      '/v1/operations/compliance/consents',
      {
        phoneNumber: number,
        principalEntity: 'Example Bank',
        purpose: 'loan servicing',
        category: 'service',
        basis: 'explicit_service_7d',
        evidenceRef: 'CRF-9',
        obtainedAt: new Date().toISOString(),
      },
      'editor',
    );
    expect(consent.statusCode).toBe(201);
    expect(
      (
        await send(
          'GET',
          `/v1/operations/compliance/consents?phoneNumber=${encodeURIComponent(number)}`,
          undefined,
          'viewer',
        )
      ).statusCode,
    ).toBe(403);
    const complaint = await send(
      'POST',
      '/v1/operations/compliance/complaints',
      {
        kind: 'customer',
        phoneNumber: number,
        receivedAt: new Date().toISOString(),
        summary: 'Called twice in an hour',
        suppress: false,
      },
      'editor',
    );
    expect(complaint.json()).toMatchObject({ status: 'open', ackDueAt: expect.any(String) });
    // The complainant is not dialed while the complaint is open.
    expect((await call({ to: number, dryRun: true })).statusCode).toBe(409);
    const moved = await send(
      'POST',
      `/v1/operations/compliance/complaints/${complaint.json().id}/transition`,
      { status: 'acknowledged' },
      'editor',
    );
    expect(moved.json()).toMatchObject({ status: 'acknowledged' });
    const exported = await send(
      'GET',
      `/v1/operations/compliance/export?from=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`,
    );
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toBe('application/zip');
    expect(exported.rawPayload.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(
      (await send('GET', '/v1/operations/compliance/ratios', undefined, 'viewer')).statusCode,
    ).toBe(200);
    const decisions = await send(
      'GET',
      `/v1/operations/compliance/decisions?phoneNumber=${encodeURIComponent(number)}`,
      undefined,
      'editor',
    );
    expect(decisions.json().items[0]).toMatchObject({ stage: 'manual', verdict: 'refuse' });
  });
});
