import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyRequest } from 'fastify';
import type { ControlStore, Role } from '@winsendotai/ovo-plugin-storage';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerOperationsRoutes } from '../../../apps/api/src/routes/operations.ts';
import { PostgresOperationsService } from '../src/index.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
const roles: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };

describe.skipIf(!postgresUrl)('production campaign contact redrive', () => {
  const organizationId = `redrive-${randomUUID()}`;
  const audit = vi.fn(async () => undefined);
  const store = { audit } as unknown as ControlStore;
  let service: PostgresOperationsService;
  const app = Fastify();

  const requireRole = (request: FastifyRequest, expected: Role) => {
    const role = String(request.headers['x-test-role'] ?? 'admin') as Role;
    if (!roles[role] || roles[role] < roles[expected])
      throw Object.assign(new Error('Insufficient role'), { statusCode: 403 });
    return { identityId: `operator-${role}`, label: role, workspaceId: organizationId, role };
  };

  async function contact() {
    const campaign = await service.campaigns.create(
      {
        operationId: randomUUID(),
        name: 'Redrive guard',
        agentReleaseId: 'release-redrive',
        fromNumber: '+14155550000',
        schedule: { localDateTime: '2026-01-15T12:00', timezone: 'UTC' },
        perNumberAttemptLimit: 3,
        maxAttemptsTotal: 10,
        maxAttemptsPerLocalDay: 10,
        activeCallPolicy: 'continue',
      },
      [{ sourceRow: 1, phoneNumber: '+14155550100', variables: {} }],
    );
    const row = await service.pool.query<{ id: string }>(
      'SELECT id FROM ovo_ops_campaign_contacts WHERE campaign_id = $1',
      [campaign.id],
    );
    return { campaign, id: row.rows[0]!.id };
  }

  const post = (contactId: string, role: Role = 'admin', payload: object = {}) =>
    app.inject({
      method: 'POST',
      url: `/v1/operations/contacts/${contactId}/redrive`,
      payload,
      headers: { 'x-test-role': role },
    });

  beforeAll(async () => {
    service = new PostgresOperationsService({
      connectionString: postgresUrl,
      organizationId,
      config: { permittedFromNumbers: [], liveEnabled: true },
    });
    await service.migrate();
    app.setErrorHandler((error: FastifyError, _request, reply) => {
      const typed = error as Error & { statusCode?: number; code?: string };
      return reply.code(typed.statusCode ?? 400).send({
        error: { code: typed.code ?? 'request_error', message: typed.message },
      });
    });
    registerOperationsRoutes({ app, operations: service, store, requireRole });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await service.pool.query(
      `DELETE FROM ovo_ops_outbox WHERE payload->>'campaignId' IN
       (SELECT id::text FROM ovo_ops_campaigns WHERE organization_id = $1)`,
      [organizationId],
    );
    await service.pool.query('DELETE FROM ovo_ops_campaigns WHERE organization_id = $1', [
      organizationId,
    ]);
    await service.close();
  });

  it('refuses a queued contact with not_failed and does not audit a retry', async () => {
    const { id } = await contact();
    const response = await post(id);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ reason: 'not_failed' });
    expect(audit).not.toHaveBeenCalled();
    const state = await service.pool.query<{ state: string }>(
      'SELECT state FROM ovo_ops_campaign_contacts WHERE id = $1',
      [id],
    );
    expect(state.rows[0]!.state).toBe('queued');
  });

  it('refuses an unknown attempt even when the contact state says failed', async () => {
    const { campaign, id } = await contact();
    const admitted = await service.campaigns.admit(campaign.id, 'redrive-worker', 60_000);
    if (admitted.kind !== 'admitted') throw new Error('contact was not admitted');
    const authorized = await service.campaigns.authorizeDial(
      id,
      'redrive-worker',
      admitted.ownerEpoch,
    );
    if (authorized.kind !== 'authorized') throw new Error('dial was not authorized');
    await service.pool.query('UPDATE ovo_ops_attempts SET status = $2 WHERE id = $1', [
      authorized.attemptId,
      'unknown',
    ]);
    await service.pool.query('UPDATE ovo_ops_campaign_contacts SET state = $2 WHERE id = $1', [
      id,
      'failed',
    ]);
    const response = await post(id);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ reason: 'unknown_outcome' });
    const persisted = await service.pool.query<{ state: string; status: string }>(
      `SELECT c.state, a.status FROM ovo_ops_campaign_contacts c
       JOIN ovo_ops_attempts a ON a.contact_id = c.id WHERE c.id = $1`,
      [id],
    );
    expect(persisted.rows[0]).toMatchObject({ state: 'failed', status: 'unknown' });
    expect(audit).not.toHaveBeenCalled();
  });

  it('requires admin, live enablement, a valid contact, and an explicit request body', async () => {
    const { id } = await contact();
    expect((await post(id, 'editor')).statusCode).toBe(403);
    expect((await post(randomUUID())).statusCode).toBe(404);
    const absentBody = await app.inject({
      method: 'POST',
      url: `/v1/operations/contacts/${id}/redrive`,
    });
    expect(absentBody.statusCode).toBe(400);
    const disabled = Fastify();
    const off = new PostgresOperationsService({
      connectionString: postgresUrl,
      organizationId,
    });
    registerOperationsRoutes({ app: disabled, operations: off, store, requireRole });
    expect(
      (
        await disabled.inject({
          method: 'POST',
          url: `/v1/operations/contacts/${id}/redrive`,
          payload: {},
        })
      ).statusCode,
    ).toBe(503);
    await disabled.close();
    await off.close();
  });

  it('queues a failed contact at the requested time and audits the redrive', async () => {
    const { id } = await contact();
    await service.pool.query('UPDATE ovo_ops_campaign_contacts SET state = $2 WHERE id = $1', [
      id,
      'failed',
    ]);
    const notBefore = '2027-01-15T12:00:00.000Z';
    const response = await post(id, 'admin', { notBefore });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ kind: 'queued' });
    const row = await service.pool.query<{ state: string; not_before: Date }>(
      'SELECT state, not_before FROM ovo_ops_campaign_contacts WHERE id = $1',
      [id],
    );
    expect(row.rows[0]).toMatchObject({ state: 'queued', not_before: new Date(notBefore) });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'operations.campaign.contact.redrive', resourceId: id }),
    );
  });
});
