import { describe, expect, it } from 'vitest';
import { Cap, type CarrierIngress } from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { compose } from '@winsendotai/ovo-runtime';
import { loadDistribution } from '../../distribution/src/load.ts';
import { createGatewayHost } from '../../../apps/media-gateway/src/gateway-host.ts';

describe('C2 media URL query capability at the production gateway adapter', () => {
  it('uses selected ingress capability: Plivo denies query, synthetic alternate carries sid/rt', async () => {
    const distribution = await loadDistribution({ role: 'gateway', profile: 'compose', env: {} });
    const net = createFixtureNet([]);
    const graph = await compose([{ id: '@winsendotai/ovo-carrier-plivo' }], distribution.catalog, {
      scope: 'process',
      net,
    });
    try {
      const plivoIngress = graph.all(Cap.carrierIngress).get('plivo') as CarrierIngress | undefined;
      expect(plivoIngress).toBeDefined();
      const alternate = {
        ...plivoIngress!,
        carrierId: 'query-fixture',
        capabilities: {
          ...plivoIngress!.capabilities,
          carrierId: 'query-fixture',
          media: { ...plivoIngress!.capabilities.media, queryOnMediaUrl: true },
        },
      };
      // Only mediaUrl is invoked. The durable store, operations and binding ports
      // remain inert; this case never opens a socket or calls a carrier.
      const store = {
        resolveSessionRoute() {},
        issueStreamGrant() {},
        reissueStream() {},
        recordCarrierCallIdMismatch() {},
        applyCarrierCallback() {},
      };
      const { hostFor } = createGatewayHost({
        publicBaseUrl: 'https://127.0.0.1:8443',
        routeSecret: 'fixture-route-secret-with-at-least-32-bytes',
        store: store as never,
        operations: { organizationId: 'workspace-1' } as never,
        distribution,
        control: { getProviderBinding: async () => undefined, getRelease: async () => undefined },
        secrets: { resolve: async () => 'offline-fixture-secret' },
        ingresses: [plivoIngress!, alternate],
        env: {},
      });
      expect(() =>
        hostFor('plivo', 'env').mediaUrl('plivo', 'env', {
          query: { sid: 'session-1', rt: 'route-token' },
        }),
      ).toThrow('does not permit media URL queries');
      const queryMedia = () =>
        hostFor('query-fixture', 'env').mediaUrl('query-fixture', 'env', {
          query: { sid: 'session-1', rt: 'route-token' },
        });
      expect(queryMedia).not.toThrow();
      const queryUrl = queryMedia();
      expect(new URL(queryUrl).searchParams.get('sid')).toBe('session-1');
      expect(new URL(queryUrl).searchParams.get('rt')).toBe('route-token');
      expect(new URL(hostFor('query-fixture', 'env').mediaUrl('query-fixture', 'env')).search).toBe(
        '',
      );
      expect(net.log).toHaveLength(0);
    } finally {
      await graph.dispose();
    }
  });
});
