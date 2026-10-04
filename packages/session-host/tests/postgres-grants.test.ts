import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresOrchestrationStore } from '../../plugin-orchestration/src/postgres.ts';
import { beginRoute } from '../../plugin-orchestration/tests/carrier-identity-support.ts';
import { createCarrierHostPorts } from '../src/host-ports.ts';
import type { CarrierTerminationOptions } from '../src/terminate.ts';

const url = process.env.OVO_TEST_POSTGRES_URL;
describe.skipIf(!url)('host ports through real PostgreSQL route grants', () => {
  const schema = `host_grants_${randomUUID().replaceAll('-', '')}`;
  let admin: PostgresOrchestrationStore;
  let store: PostgresOrchestrationStore;
  beforeAll(async () => {
    admin = new PostgresOrchestrationStore({ connectionString: url });
    await admin.pool.query(`CREATE SCHEMA ${schema}`);
    store = new PostgresOrchestrationStore({
      connectionString: url,
      options: `-c search_path=${schema}`,
      application_name: schema,
    });
    await store.migrate();
  });
  afterAll(async () => {
    if (store) await store.close();
    if (admin) {
      await admin.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.close();
    }
  });
  function ports() {
    return createCarrierHostPorts({
      publicBaseUrl: 'https://example.test',
      routeSecret: 'r'.repeat(32),
      operations: {
        admitInbound: async () => ({ kind: 'hangup' }),
        confirmCallback: async () => ({ kind: 'hangup' }),
      },
      orchestration: {
        resolveSessionRoute: (query: Parameters<typeof store.resolveSessionRoute>[0]) =>
          store.resolveSessionRoute(query),
        issueStreamGrant: (input: Parameters<typeof store.issueStreamGrant>[0]) =>
          store.issueStreamGrant(input),
        reissueStream: (input: Parameters<typeof store.reissueStream>[0]) =>
          store.reissueStream(input),
        recordCarrierCallIdMismatch: (
          input: Parameters<typeof store.recordCarrierCallIdMismatch>[0],
        ) => store.recordCarrierCallIdMismatch(input),
        applyCallEvent: async () => ({ kind: 'applied' }),
      },
      bindings: async () => ({
        bindingId: 'binding-test',
        pluginId: 'carrier',
        workspaceId: schema,
        config: {},
        secret: 'secret',
      }),
    } as never);
  }
  it('mints through the host, authenticates once, and denies a late grant after termination', async () => {
    const { route } = await beginRoute(store, schema, 'host-path');
    const terminationStore: CarrierTerminationOptions['store'] = store;
    expect(terminationStore).toBe(store);
    const host = ports();
    const query = {
      carrierId: 'carrier-test',
      bindingId: 'binding-test',
      dialRequestId: route.dialRequestId,
    };
    const grant = await host.streamForDial(query);
    expect(grant.kind).toBe('stream');
    if (grant.kind !== 'stream') return;
    expect(Buffer.from(grant.routeParams.rt, 'base64url').length).toBe(32);
    expect(
      await store.authenticateSessionRoute(route.sessionId, grant.routeParams.rt),
    ).toMatchObject({ sessionId: route.sessionId });
    expect(
      await store.authenticateSessionRoute(route.sessionId, grant.routeParams.rt),
    ).toBeUndefined();
    await store.requestSessionTermination(route, 'owner_lost');
    expect(await host.streamForDial(query)).toEqual({ kind: 'ended' });
  });
});
