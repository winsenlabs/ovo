import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { PostgresControlStore } from '@winsendotai/ovo-plugin-storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerOperationsRoutes } from '../../../apps/api/src/routes/operations.ts';
import { registerCampaignCarrierResolver } from '../../../apps/api/src/operations-plugin.ts';
import { PostgresOperationsService } from '../src/index.ts';
import { apiCarrierFixture } from './api-carrier-fixture.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!postgresUrl)('production carrier snapshot and campaign API', () => {
  const workspaceId = `o2-api-carrier-${randomUUID()}`;
  const fromNumber = '+14155550000';
  let operations: PostgresOperationsService;
  let store: PostgresControlStore;
  let app: ReturnType<typeof Fastify>;
  let basicReleaseId: string;
  let pinnedReleaseId: string;
  let pinnedBindingId: string;

  beforeAll(async () => {
    store = await PostgresControlStore.open(postgresUrl!);
    await store.ensureWorkspace(workspaceId, 'O2 carrier API');
    operations = new PostgresOperationsService({
      connectionString: postgresUrl,
      organizationId: workspaceId,
      config: { permittedFromNumbers: [fromNumber], liveEnabled: true },
    });
    await operations.migrate();
    const fixture = apiCarrierFixture();
    registerCampaignCarrierResolver(operations, fixture.catalog, fixture.controls);
    const makeAgent = (name: string) =>
      store.createAgent(
        workspaceId,
        AgentConfig.parse({
          name,
          mode: 'announcement',
          message: 'Hello {{name}}',
          variables: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
            additionalProperties: false,
          },
        }),
      );
    const basic = await makeAgent('Basic carrier');
    basicReleaseId = (
      await store.createRelease({
        workspaceId,
        agent: basic,
        plugins: [],
        createdBy: 'operator',
        id: randomUUID(),
      })
    ).id;
    pinnedBindingId = randomUUID();
    const pinned = await makeAgent('Pinned carrier');
    pinnedReleaseId = (
      await store.createRelease({
        workspaceId,
        agent: pinned,
        createdBy: 'operator',
        id: randomUUID(),
        plugins: [{ id: 'carrier.fixture', version: '1.0.0' }],
        selections: {
          carrier: {
            pluginId: 'carrier.fixture',
            version: '1.0.0',
            bindingId: pinnedBindingId,
            binding: {
              provider: 'twilio',
              config: { cps: 0.5 },
              credentialId: randomUUID(),
              fingerprint: 'pinned',
              updatedAt: new Date().toISOString(),
            },
            config: {},
          },
        },
      })
    ).id;
    app = Fastify();
    app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) =>
      reply.code(error.statusCode ?? 400).send({
        error: { code: error.code ?? 'request_error', message: error.message },
      }),
    );
    registerOperationsRoutes({
      app,
      operations,
      store,
      requireRole: (_request, role) => ({
        identityId: 'operator',
        label: 'Operator',
        workspaceId,
        role,
      }),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await operations?.close();
    await store?.close();
  });

  const campaignPayload = (releaseId: string) => ({
    operationId: randomUUID(),
    name: 'Carrier campaign',
    releaseId,
    fromNumber,
    schedule: { localDateTime: '2000-01-01T00:00', timezone: 'UTC' },
    perNumberAttemptLimit: 1,
    maxAttemptsTotal: 1,
    maxAttemptsPerLocalDay: 1,
    activeCallPolicy: 'continue',
    contacts: [{ sourceRow: 1, phoneNumber: '+14155550188', variables: { name: 'A' } }],
  });

  it('persists the immutable selected carrier even after its live binding disappears', async () => {
    expect(await store.getProviderBinding(workspaceId, pinnedBindingId)).toBeUndefined();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/operations/campaigns',
      payload: campaignPayload(pinnedReleaseId),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      carrierPluginId: 'carrier.fixture',
      carrierId: 'twilio',
      carrierBindingId: pinnedBindingId,
      bindingCps: 0.5,
    });
    expect(
      (
        await operations.pool.query(
          'SELECT carrier_plugin_id,carrier_id,carrier_binding_id,binding_cps::text FROM ovo_ops_campaigns WHERE id=$1',
          [response.json().id],
        )
      ).rows[0],
    ).toEqual({
      carrier_plugin_id: 'carrier.fixture',
      carrier_id: 'twilio',
      carrier_binding_id: pinnedBindingId,
      binding_cps: '0.5',
    });
  });

  it('patches concurrency with an optimistic version and returns conflict on stale version', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/operations/campaigns',
      payload: campaignPayload(basicReleaseId),
    });
    expect(created.statusCode).toBe(201);
    const url = `/v1/operations/campaigns/${created.json().id}`;
    const payload = { expectedVersion: created.json().version, maxConcurrency: 3 };
    const changed = await app.inject({ method: 'PATCH', url, payload });
    expect(changed.json()).toMatchObject({
      maxConcurrency: 3,
      version: payload.expectedVersion + 1,
    });
    expect((await app.inject({ method: 'PATCH', url, payload })).statusCode).toBe(409);
  });

  it('validates explicit inbound plugin and binding while preserving NULL env selection', async () => {
    const route = `/v1/operations/inbound/routes/+14155550991`;
    const base = {
      expectedVersion: null,
      releaseId: basicReleaseId,
      variables: { name: 'Inbound' },
    };
    const environment = await app.inject({ method: 'PUT', url: route, payload: base });
    expect(environment.json()).toMatchObject({ carrierPluginId: null, carrierBindingId: null });
    const absent = await app.inject({
      method: 'PUT',
      url: route,
      payload: { ...base, expectedVersion: 1, carrierPluginId: 'carrier.unknown' },
    });
    expect(absent.json()).toMatchObject({ error: { code: 'inbound_carrier_invalid' } });
    const credential = await store.createCredential({
      workspaceId,
      label: 'Carrier key',
      provider: 'twilio',
      type: 'api-key',
      environment: 'production',
      backend: 'encrypted-store',
      permittedAgentIds: [],
      createdBy: 'operator',
      fingerprint: `sha256:${randomUUID()}`,
      secret: {
        ciphertext: Buffer.from('ciphertext'),
        nonce: Buffer.alloc(12, 1),
        authTag: Buffer.alloc(16, 2),
        backendRef: null,
      },
    });
    const binding = await store.createProviderBinding({
      workspaceId,
      label: 'Carrier',
      provider: 'twilio',
      environment: 'production',
      credentialId: credential.id,
      config: { cps: 2 },
      kind: 'carrier',
      pluginId: 'carrier.fixture',
    });
    const selected = await app.inject({
      method: 'PUT',
      url: route,
      payload: {
        ...base,
        expectedVersion: 1,
        carrierPluginId: 'carrier.fixture',
        carrierBindingId: binding.id,
      },
    });
    expect(selected.json()).toMatchObject({
      carrierPluginId: 'carrier.fixture',
      carrierBindingId: binding.id,
    });
    const mismatch = await app.inject({
      method: 'PUT',
      url: route,
      payload: {
        ...base,
        expectedVersion: 2,
        carrierPluginId: 'carrier.fixture',
        carrierBindingId: randomUUID(),
      },
    });
    expect(mismatch.json()).toMatchObject({ error: { code: 'inbound_carrier_invalid' } });
  });
});
