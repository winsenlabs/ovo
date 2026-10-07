import { expect, it } from 'vitest';
import { Cap, type AudioFilter } from '@winsendotai/ovo-contracts';
import { compose, PluginRegistry } from '@winsendotai/ovo-runtime';
import { loadDistribution } from '../../distribution/src/load.ts';

it('loads and composes the telephony audio filter through the distribution catalog', async () => {
  const loaded = await loadDistribution({ role: 'gateway', profile: 'compose', env: {} });
  const registry = new PluginRegistry(loaded.catalog);
  const filter = registry.resolve('audio-filter', '@winsendotai/ovo-audio-filter-telephony');
  expect(filter.manifest.contractVersion).toBe(2);
  const graph = await compose([{ id: filter.manifest.id }], loaded.catalog, { scope: 'session' });
  try {
    const audio = graph.get(Cap.audioFilter) as AudioFilter;
    audio.start(8000);
    expect(audio.filter(new Int16Array(160)).length).toBe(160);
  } finally {
    await graph.dispose();
  }
});
