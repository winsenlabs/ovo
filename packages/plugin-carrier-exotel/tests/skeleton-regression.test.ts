import { Cap } from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { compose } from '@winsendotai/ovo-runtime';
import { describe, expect, it } from 'vitest';
import { loadDistribution } from '../../distribution/src/load.ts';

describe('Exotel catalog entry', () => {
  it('loads and composes the carrier from the production distribution', async () => {
    const installed = await loadDistribution({ role: 'gateway', profile: 'compose', env: {} });
    const definition = installed.catalog.find(
      (plugin) => plugin.manifest.id === '@winsendotai/ovo-carrier-exotel',
    );
    expect(definition, 'Exotel must be installed by the production catalog').toBeDefined();
    expect(definition!.manifest).toMatchObject({
      id: '@winsendotai/ovo-carrier-exotel',
      contractVersion: 2,
      kind: 'carrier',
      provider: 'exotel',
      provides: [Cap.carrierControl, Cap.carrierIngress],
    });
    const graph = await compose([{ id: definition!.manifest.id }], [definition!], {
      scope: 'process',
      net: createFixtureNet([]),
    });
    try {
      expect(graph.all(Cap.carrierIngress).get('exotel')).toMatchObject({ carrierId: 'exotel' });
      expect(graph.all(Cap.carrierControl).get('exotel')).toHaveProperty('create');
    } finally {
      await graph.dispose();
    }
  });
});
