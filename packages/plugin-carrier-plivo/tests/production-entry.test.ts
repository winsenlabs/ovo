import { describe, expect, it } from 'vitest';
import { Cap, type CarrierControlFactory, type CarrierIngress } from '@winsendotai/ovo-contracts';
import { loadDistribution } from '../../distribution/src/load.ts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { compose } from '@winsendotai/ovo-runtime';

describe('Plivo production catalog entry', () => {
  it('loads the first-party package and composes both real carrier capabilities', async () => {
    const loaded = await loadDistribution({ role: 'gateway', profile: 'compose', env: {} });
    const id = '@winsendotai/ovo-carrier-plivo';
    expect(loaded.catalog.find((item) => item.manifest.id === id)?.manifest).toMatchObject({
      kind: 'carrier',
      provider: 'plivo',
      contractVersion: 2,
    });
    const net = createFixtureNet([]);
    const composition = await compose([{ id }], loaded.catalog, { scope: 'process', net });
    try {
      const control = composition.all(Cap.carrierControl).get('plivo') as
        CarrierControlFactory | undefined;
      const ingress = composition.all(Cap.carrierIngress).get('plivo') as
        CarrierIngress | undefined;
      expect(control?.capabilities.carrierId).toBe('plivo');
      expect(ingress?.routes.find((route) => route.purpose === 'answer')).toBeDefined();
      expect(net.log).toHaveLength(0);
    } finally {
      await composition.dispose();
    }
  });
});
