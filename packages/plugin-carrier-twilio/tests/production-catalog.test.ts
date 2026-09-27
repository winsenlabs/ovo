import { Cap, type CarrierControlFactory } from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { compose } from '@winsendotai/ovo-runtime';
import { describe, expect, it } from 'vitest';
import { loadDistribution } from '../../distribution/src/load.ts';

describe('Twilio production catalog', () => {
  it('loads and composes the new carrier instead of the transitional bridge', async () => {
    const installed = await loadDistribution({ role: 'gateway', profile: 'compose', env: {} });
    const definitions = installed.catalog.filter(
      (plugin) => plugin.manifest.id === '@winsendotai/ovo-carrier-twilio',
    );
    expect(definitions).toHaveLength(1);
    const definition = definitions[0]!;
    const row = installed.processRows.find((item) => item.id === definition.manifest.id);
    expect(row).toBeDefined();
    expect(definition.manifest.provides).toContain(Cap.carrierIngress);
    const net = createFixtureNet([]);
    const graph = await compose([row!], [definition], { scope: 'process', net });
    try {
      expect(graph.all(Cap.carrierIngress).get('twilio')).toMatchObject({
        carrierId: 'twilio',
        routes: expect.arrayContaining([expect.objectContaining({ purpose: 'resume' })]),
      });
      const control = graph.all(Cap.carrierControl).get('twilio') as CarrierControlFactory;
      expect(control.capabilities.control).toMatchObject({ amd: 'async', maxDuration: true });
      expect(control.create).toBeTypeOf('function');
      expect(net.log).toHaveLength(0);
    } finally {
      await graph.dispose();
    }
  });
});
