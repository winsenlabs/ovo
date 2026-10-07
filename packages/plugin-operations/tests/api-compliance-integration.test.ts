import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { PostgresControlStore, type Role } from '@winsendotai/ovo-plugin-storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerOperationsRoutes } from '../../../apps/api/src/routes/operations.ts';
import { registerCampaignCarrierResolver } from '../../../apps/api/src/operations-plugin.ts';
import { PostgresOperationsService } from '../src/index.ts';
import { apiCarrierFixture } from './api-carrier-fixture.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
const integration = postgresUrl ? describe : describe.skip;
const VARIABLES = {
  type: 'object',
  properties: { name: { type: 'string', minLength: 1 }, amountDue: { type: 'string' } },
  required: ['name'],
  additionalProperties: false,
};

/** Today's ISO weekday in UTC, and every other day: windows open or closed all test long. */
const today = ((new Date().getUTCDay() + 6) % 7) + 1;
const OPEN = { start: '00:00', end: '23:59', days: [today], timezone: 'UTC' };
const CLOSED = { ...OPEN, days: [1, 2, 3, 4, 5, 6, 7].filter((day) => day !== today) };

integration('outbound compliance through the operations API', () => {
  const workspaceId = `operations-compliance-${randomUUID()}`;
  const fromNumber = '+14155550000';
  let operations: PostgresOperationsService;
  let store: PostgresControlStore;
  let app: ReturnType<typeof Fastify>;
  const releases: Record<'plain' | 'open' | 'closed', string> = {
    plain: '',
    open: '',
    closed: '',
  };

  function requireRole(request: FastifyRequest, expected: Role) {
    const role = String(request.headers['x-test-role'] ?? 'admin') as Role;
    const rank: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };
    if (!rank[role] || rank[role] < rank[expected])
      throw Object.assign(new Error('Insufficient role'), { statusCode: 403, code: 'forbidden' });
    return { identityId: `operator-${role}`, label: `Operator ${role}`, workspaceId, role };
  }

  /**
   * Compliance blocks by release id. The store re-parses configs with AgentConfig, which keeps
   * `compliance` only once the contract carries the field (a cross-lane request this wave), so the
   * routes read releases through a getter that restores the block the release was published with.
   */
  const compliance = new Map<string, unknown>();
  function restoreCompliance(target: PostgresControlStore): PostgresControlStore {
    const view: Record<string, unknown> = {};
    const keys = new Set<string>(Object.getOwnPropertyNames(target));
    for (
      let prototype = Object.getPrototypeOf(target);
      prototype && prototype !== Object.prototype;
      prototype = Object.getPrototypeOf(prototype)
    )
      for (const key of Object.getOwnPropertyNames(prototype)) keys.add(key);
    for (const key of keys) {
      const value = (target as unknown as Record<string, unknown>)[key];
      view[key] = typeof value === 'function' ? value.bind(target) : value;
    }
    view.getRelease = async (workspace: string, id: string) => {
      const found = await target.getRelease(workspace, id);
      return found && compliance.has(id)
        ? { ...found, config: { ...found.config, compliance: compliance.get(id) } }
        : found;
    };
    return view as unknown as PostgresControlStore;
  }

  async function release(callingHours?: typeof OPEN) {
    const agent = await store.createAgent(
      workspaceId,
      AgentConfig.parse({
        name: 'Collections',
        mode: 'announcement',
        message: 'Hello {{name}}',
        variables: VARIABLES,
      }),
    );
    const id = (
      await store.createRelease({
        workspaceId,
        agent,
        plugins: [],
        createdBy: 'operator-admin',
        id: randomUUID(),
      })
    ).id;
    if (callingHours) compliance.set(id, { callingHours });
    return id;
  }

  const call = (payload: Record<string, unknown>, role: Role = 'admin') =>
    app.inject({
      method: 'POST',
      url: '/v1/calls',
      payload: {
        operationId: randomUUID(),
        releaseId: releases.plain,
        fromNumber,
        to: '+14155557001',
        variables: { name: 'Asha' },
        ...payload,
      },
      headers: { 'x-test-role': role },
    });

  beforeAll(async () => {
    operations = new PostgresOperationsService({
      connectionString: postgresUrl,
      organizationId: workspaceId,
      config: { permittedFromNumbers: [fromNumber], liveEnabled: true },
    });
    const carrier = apiCarrierFixture();
    registerCampaignCarrierResolver(operations, carrier.catalog, carrier.controls);
    store = await PostgresControlStore.open(postgresUrl!);
    await Promise.all([operations.migrate(), store.ensureWorkspace(workspaceId, 'Compliance')]);
    releases.plain = await release();
    releases.open = await release(OPEN);
    releases.closed = await release(CLOSED);
    app = Fastify();
    app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
      const typed = error as Error & { statusCode?: number; code?: string };
      reply.code(typed.statusCode ?? 400).send({
        error: { code: typed.code ?? 'request_error', message: typed.message },
      });
    });
    registerOperationsRoutes({ app, operations, store: restoreCompliance(store), requireRole });
    await app.ready();
  });

  afterAll(async () => {
    await operations?.pool.query('DELETE FROM ovo_ops_suppressions WHERE organization_id = $1', [
      workspaceId,
    ]);
    await app?.close();
    await operations?.close();
    await store?.close();
  });

  async function campaignCount() {
    const result = await operations.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM ovo_ops_campaigns WHERE organization_id = $1',
      [workspaceId],
    );
    return Number(result.rows[0]!.count);
  }

  it('refuses a manual dial to a do-not-call number before anything is queued', async () => {
    await operations.campaigns.doNotCall.add('+14155557002', 'Asked not to be called', {
      source: 'opt_out',
    });
    const before = await campaignCount();
    const refused = await call({ to: '+14155557002' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: 'do_not_call' } });
    expect(await campaignCount()).toBe(before);
  });

  it('enforces the release calling hours on manual dials and snapshots them', async () => {
    const closed = await call({ releaseId: releases.closed });
    expect(closed.statusCode).toBe(409);
    expect(closed.json()).toMatchObject({
      error: {
        code: 'outside_calling_hours',
        details: { nextOpenAt: expect.any(String), callingWindow: CLOSED },
      },
    });
    const operationId = randomUUID();
    const opened = await call({ releaseId: releases.open, operationId });
    expect(opened.statusCode).toBe(202);
    // A manual dial is judged when it is requested; its campaign carries no window, so a call
    // accepted just before closing is never requeued and dialed unasked the next morning.
    const campaign = await operations.campaigns.get(opened.json().campaignId);
    expect(campaign.callingWindow).toBeNull();
    // A retry of the accepted launch replays its receipt, even once the window has closed.
    compliance.set(releases.open, { callingHours: CLOSED });
    const retried = await call({ releaseId: releases.open, operationId });
    expect(retried.json()).toEqual(opened.json());
    compliance.set(releases.open, { callingHours: OPEN });
  });

  it('dry-runs a test call through every check without queueing it', async () => {
    const before = await campaignCount();
    const operationId = randomUUID();
    const dry = await call({ operationId, dryRun: true, releaseId: releases.open });
    expect(dry.statusCode).toBe(200);
    expect(dry.json()).toEqual({
      dryRun: true,
      releaseId: releases.open,
      to: '+14155557001',
      fromNumber,
      variables: ['name'],
      callingWindow: OPEN,
      carrierId: 'twilio',
    });
    expect(await campaignCount()).toBe(before);
    expect(await store.getCall(workspaceId, operationId)).toBeUndefined();
    expect((await call({ dryRun: true, variables: {} })).statusCode).toBe(422);
    expect((await call({ dryRun: true, to: '+14155557002' })).statusCode).toBe(409);
  });

  it('validates contact variables against the release schema at import', async () => {
    const campaign = (contacts: unknown[], extra: Record<string, unknown> = {}) =>
      app.inject({
        method: 'POST',
        url: '/v1/operations/campaigns',
        headers: { 'x-test-role': 'editor' },
        payload: {
          operationId: randomUUID(),
          name: 'Collections October',
          releaseId: releases.closed,
          fromNumber,
          schedule: { localDateTime: '2026-01-15T12:00', timezone: 'Asia/Kolkata' },
          perNumberAttemptLimit: 1,
          maxAttemptsTotal: 10,
          maxAttemptsPerLocalDay: 10,
          activeCallPolicy: 'continue',
          contacts,
          ...extra,
        },
      });
    const invalid = await campaign([
      { sourceRow: 2, phoneNumber: '+14155557010', variables: { name: 'Asha' } },
      { sourceRow: 3, phoneNumber: '+14155557011', variables: { nickname: 'R' } },
    ]);
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({
      error: {
        code: 'invalid_contact_variables',
        details: [{ row: 3, errors: expect.arrayContaining([expect.stringContaining('name')]) }],
      },
    });
    expect(JSON.stringify(invalid.json())).not.toContain('"R"');
    // G4 regression: a campaign window may only narrow the agent's. Every day 09:00-18:00 reaches
    // today, which the release's window leaves out, so the campaign is refused, not widened.
    const widened = await campaign(
      [{ sourceRow: 2, phoneNumber: '+14155557010', variables: { name: 'Asha' } }],
      { callingWindow: { start: '09:00', end: '18:00' } },
    );
    expect(widened.statusCode).toBe(422);
    expect(widened.json()).toMatchObject({
      error: { code: 'policy_widens_floor', details: { problems: [{ source: 'campaign' }] } },
    });
    const created = await campaign(
      [{ sourceRow: 2, phoneNumber: '+14155557010', variables: { name: 'Asha' } }],
      { callingWindow: { start: '09:00', end: '18:00', days: CLOSED.days, timezone: 'UTC' } },
    );
    expect(created.statusCode).toBe(201);
    // The campaign keeps its own window; both windows are judged together at every dial.
    expect(created.json().callingWindow).toEqual({
      start: '09:00',
      end: '18:00',
      days: CLOSED.days,
      timezone: 'UTC',
    });
    expect(created.json().compliance).toMatchObject({
      agentWindow: {
        rules: [{ start: '00:00', end: '23:59', days: CLOSED.days }],
        timezone: 'UTC',
      },
      campaignWindow: { rules: [{ start: '09:00', end: '18:00', days: CLOSED.days }] },
    });
    const inherited = await campaign([
      { sourceRow: 2, phoneNumber: '+14155557012', variables: { name: 'Ravi' } },
    ]);
    expect(inherited.json().callingWindow).toBeNull();
    expect(inherited.json().compliance.agentWindow.rules[0].days).toEqual(CLOSED.days);
    const schema = await operations.pool.query<{ variables_schema: unknown }>(
      'SELECT variables_schema FROM ovo_ops_campaigns WHERE id = $1',
      [created.json().id],
    );
    expect(schema.rows[0]!.variables_schema).toEqual(VARIABLES);

    const contacts = await app.inject({
      method: 'GET',
      url: `/v1/operations/campaigns/${created.json().id}/contacts?limit=1`,
      headers: { 'x-test-role': 'editor' },
    });
    expect(contacts.json()).toMatchObject({
      items: [{ sourceRow: 2, phoneNumber: '+14155557010', variables: { name: 'Asha' } }],
      nextCursor: 2,
    });
    const hidden = await app.inject({
      method: 'GET',
      url: `/v1/operations/campaigns/${created.json().id}/contacts`,
      headers: { 'x-test-role': 'viewer' },
    });
    expect(hidden.statusCode).toBe(403);
  });

  it('flags variable errors and do-not-call rows in the CSV preview', async () => {
    const preview = await app.inject({
      method: 'POST',
      url: '/v1/operations/campaigns/preview',
      headers: { 'x-test-role': 'editor' },
      payload: {
        csv: 'phone,name\n+14155557002,Asha\n+14155557020,\n',
        mapping: { phone: 'phone', variables: { name: 'name' } },
        releaseId: releases.plain,
      },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      doNotCall: [2],
      errors: [{ row: 3, field: 'variables', message: expect.stringContaining('name') }],
    });
  });

  it('imports the do-not-call list in bulk and looks numbers up', async () => {
    const imported = await app.inject({
      method: 'POST',
      url: '/v1/operations/suppressions/import',
      headers: { 'x-test-role': 'editor' },
      payload: {
        entries: [
          { phoneNumber: '+14155557030', reason: 'Registry' },
          { phoneNumber: '+14155557002', reason: 'Registry' },
        ],
      },
    });
    expect(imported.json()).toEqual({ added: 1, updated: 1 });
    const found = await app.inject({
      method: 'GET',
      url: '/v1/operations/suppressions/%2B14155557002',
      headers: { 'x-test-role': 'viewer' },
    });
    // A bulk entry never overwrites the caller's own opt-out.
    expect(found.json()).toMatchObject({ source: 'opt_out', reason: 'Asked not to be called' });
    const missing = await app.inject({
      method: 'GET',
      url: '/v1/operations/suppressions/%2B14155557999',
      headers: { 'x-test-role': 'viewer' },
    });
    expect(missing.statusCode).toBe(404);
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/operations/suppressions/import',
      headers: { 'x-test-role': 'editor' },
      payload: { entries: [{ phoneNumber: '12345', reason: 'x' }] },
    });
    expect(bad.json()).toMatchObject({
      error: { code: 'invalid_phone_numbers', details: { entries: [1] } },
    });
    const audit = (await store.listAudit(workspaceId, 100)).items;
    expect(audit.map((entry) => entry.action)).toContain('operations.suppression.import');
    expect(JSON.stringify(audit)).not.toContain('14155557030');
  });
});
