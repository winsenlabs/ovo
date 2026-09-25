import { expect, it } from 'vitest';
import { Cap, type TurnDetectorFactory, type VadAnalyzerFactory } from '@winsendotai/ovo-contracts';
import { compose, PluginRegistry } from '@winsendotai/ovo-runtime';
import { loadDistribution } from '../../distribution/src/load.ts';

it('loads and composes both v2 session plugins through the frozen distribution catalog', async () => {
  const loaded = await loadDistribution({ role: 'gateway', profile: 'compose', env: {} });
  const registry = new PluginRegistry(loaded.catalog);
  const turn = registry.resolve('turn-detector', '@winsendotai/ovo-turn-detector-default');
  const vad = registry.resolve('vad', '@winsendotai/ovo-vad-energy');
  expect(turn.manifest.contractVersion).toBe(2);
  expect(vad.manifest.contractVersion).toBe(2);
  expect(registry.get(turn.manifest.id)).toBe(turn);
  expect(registry.get(vad.manifest.id)).toBe(vad);
  const graph = await compose([{ id: turn.manifest.id }, { id: vad.manifest.id }], loaded.catalog, { scope: 'session' });
  try {
    expect((graph.get(Cap.turnDetector) as TurnDetectorFactory).create).toBeTypeOf('function');
    expect((graph.get(Cap.vad) as VadAnalyzerFactory).create(8000).frameSamples).toBe(160);
  } finally { await graph.dispose(); }
});
