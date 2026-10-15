import { expect, it, vi } from 'vitest';
import { createGatewayHost } from '../src/gateway-host.ts';
import { gatewayOperationsConfig } from '../src/gateway-config.ts';
import { catalog, fixture } from '../../../packages/session-host/tests/compat-support.ts';
import {
  fixtureCarrierIngress,
  fixtureWebhook,
  signFixtureRequest,
} from '../../../packages/conformance/src/drivers/fixture-carrier.ts';

/** A number bound to a routing release, as effectiveInboundRoute reads it. */
const routedRow = {
  release_id: null,
  routing_release_id: 'routing-release',
  variables: {},
  version: '1',
  carrier_plugin_id: 'carrier',
  carrier_binding_id: 'binding-A',
  router_release_id: 'router-release',
  default_release_id: 'default-release',
  routing_point_id: 'point',
  routing_version: 3,
};

it.each([
  [true, 'router-release'],
  [false, 'default-release'],
] as const)(
  'checks a routed number against the release that answers (routing %s: %s)',
  async (routingEnabled, expected) => {
    const compatible = fixture();
    const ingress = fixtureCarrierIngress();
    const admit = vi.fn(async () => ({
      kind: 'reserved',
      admissionId: 'admission',
      sessionId: 'session',
      jobId: 'job',
      workerId: 'worker',
      workerEndpoint: 'ws://127.0.0.1:1/internal/media',
      releaseId: expected,
      routeVersion: 1,
    }));
    const getRelease = vi.fn(
      async () =>
        ({
          config: {
            ...compatible.config,
            costPolicy: { ...compatible.config.costPolicy, priceCards: compatible.priceCards },
          },
          selections: compatible.selections,
        }) as never,
    );
    const query = vi.fn(async () => ({ rows: [routedRow] }));
    const { hostFor } = createGatewayHost({
      publicBaseUrl: 'https://voice.example',
      routeSecret: 'x'.repeat(32),
      store: {
        resolveSessionRoute: async () => undefined,
        issueStreamGrant: async () => undefined,
        reissueStream: async () => undefined,
        recordCarrierCallIdMismatch: async () => undefined,
      } as never,
      operations: {
        organizationId: 'org',
        config: { routingEnabled },
        pool: { query },
        inboundGateway: { admit },
      } as never,
      distribution: {
        catalog: catalog({ carrier: { provider: 'fixture' } }),
        defaults: {},
      } as never,
      control: {
        getProviderBinding: async (_org, id) => ({
          id,
          workspaceId: 'org',
          provider: 'fixture',
          pluginId: 'carrier',
          credentialId: 'credential',
          config: { model: 'ok' },
        }),
        getRelease,
      },
      secrets: { resolve: async () => 'fixture-secret' } as never,
      ingresses: [ingress],
      env: {},
    });
    const host = hostFor('fixture', 'binding-A');
    const callback = new URL(host.callbackUrl('fixture', 'binding-A', 'inbound'));
    const req = signFixtureRequest(
      'fixture-secret',
      fixtureWebhook({
        externalUrl: callback.href,
        bindingId: 'binding-A',
        query: Object.fromEntries(callback.searchParams),
        form: { CallSid: 'call-A', From: '+14155550101', To: '+14155550102' },
      }),
    );
    const result = ingress.routes.find((route) => route.purpose === 'inbound')!.handle(req, host);
    await expect(result).resolves.toMatchObject({ status: 200 });
    expect(getRelease).toHaveBeenCalledWith('org', expected);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ovo_routing_releases'), [
      'org',
      '+14155550102',
    ]);
    expect(admit).toHaveBeenCalledOnce();
  },
);

it('reads OVO_ROUTING_ENABLED into the operations config, off by default', () => {
  expect(gatewayOperationsConfig({})).toEqual({
    liveEnabled: false,
    permittedFromNumbers: [],
    routingEnabled: false,
  });
  expect(
    gatewayOperationsConfig({
      OVO_ROUTING_ENABLED: 'true',
      OVO_LIVE_DIAL_ENABLED: 'true',
      OVO_PERMITTED_FROM_NUMBERS: ' +14155550100, ,+14155550101',
    }),
  ).toEqual({
    liveEnabled: true,
    permittedFromNumbers: ['+14155550100', '+14155550101'],
    routingEnabled: true,
  });
  expect(gatewayOperationsConfig({ OVO_ROUTING_ENABLED: '1' }).routingEnabled).toBe(false);
});
