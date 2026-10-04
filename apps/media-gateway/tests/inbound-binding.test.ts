import { expect, it, vi } from 'vitest';
import { createGatewayHost } from '../src/gateway-host.ts';
import { catalog, fixture } from '../../../packages/session-host/tests/compat-support.ts';
import {
  fixtureCarrierIngress,
  fixtureWebhook,
  signFixtureRequest,
} from '../../../packages/conformance/src/drivers/fixture-carrier.ts';

it.each([
  ['binding mismatch', 'carrier', 'binding-B', 'fixture', 'binding-A', false],
  ['environment carrier mismatch', null, null, 'other-carrier', 'env', false],
  ['matching binding', 'carrier', 'binding-A', 'fixture', 'binding-A', true],
] as const)(
  'checks authenticated inbound identity: %s',
  async (_name, pluginId, bindingId, environmentCarrierId, requestBinding, allowed) => {
    const compatible = fixture();
    const ingress = fixtureCarrierIngress();
    const admit = vi.fn(async () => ({
      kind: 'reserved',
      admissionId: 'admission',
      sessionId: 'session',
      jobId: 'job',
      workerId: 'worker',
      workerEndpoint: 'ws://127.0.0.1:1/internal/media',
      releaseId: 'release-B',
      routeVersion: 1,
    }));
    const selected = {
      release_id: 'release-B',
      carrier_plugin_id: pluginId,
      carrier_binding_id: bindingId,
    };
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
        pool: { query: async () => ({ rows: [selected] }) },
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
        getRelease: async () =>
          ({
            config: {
              ...compatible.config,
              costPolicy: {
                ...compatible.config.costPolicy,
                priceCards: compatible.priceCards,
              },
            },
            selections: compatible.selections,
          }) as never,
      },
      secrets: { resolve: async () => 'fixture-secret' } as never,
      ingresses: [ingress],
      environmentCarrierId,
      env: {
        OVO_CARRIER_ENV_BINDINGS: JSON.stringify({
          fixture: { authToken: 'fixture-secret', model: 'ok' },
        }),
      },
    });
    const host = hostFor('fixture', requestBinding);
    const callback = new URL(host.callbackUrl('fixture', requestBinding, 'inbound'));
    const req = signFixtureRequest(
      'fixture-secret',
      fixtureWebhook({
        externalUrl: callback.href,
        bindingId: requestBinding,
        query: Object.fromEntries(callback.searchParams),
        form: { CallSid: 'call-A', From: '+14155550101', To: '+14155550102' },
      }),
    );
    const result = ingress.routes.find((route) => route.purpose === 'inbound')!.handle(req, host);
    if (allowed) {
      await expect(result).resolves.toMatchObject({ status: 200 });
      expect(admit).toHaveBeenCalledOnce();
    } else {
      await expect(result).rejects.toThrow(/Inbound route (binding|environment carrier) differs/);
      expect(admit).not.toHaveBeenCalled();
    }
  },
);
