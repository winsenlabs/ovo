import { Cap, type CapabilityMap, type DecisionPort } from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { expect, expectTypeOf, it } from 'vitest';
import { loadDistribution } from '../../distribution/src/load.ts';

const ID = '@winsendotai/ovo-decision-jev';

// The executable proof of the `TypedCapabilities` edit: `Cap.decision` resolves to `DecisionPort`
// through `CapabilityMap`, which is what makes `ctx.provide(Cap.decision, …)` in src/index.ts
// type-checked rather than an `unknown` hole. `compose().get()` is deliberately `(key: string) =>
// unknown` in the runtime, so the type cannot be asserted from the composed graph itself.
it('resolves Cap.decision to DecisionPort through CapabilityMap', () => {
  expectTypeOf<CapabilityMap[typeof Cap.decision]>().toEqualTypeOf<DecisionPort>();
});

it('loads from the production catalog and provides a typed DecisionPort', async () => {
  const installed = await loadDistribution({ role: 'gateway', profile: 'compose', env: {} });
  const resolver = definePlugin(
    {
      id: 'p1-decision-test-secrets',
      version: '0.1.0',
      contractVersion: 1,
      scope: 'process',
      provides: [Cap.secrets],
      requires: [],
      configSchema: { type: 'object' },
      secretFields: [],
    },
    (ctx) => {
      ctx.provide(Cap.secrets, { resolve: async () => 'fixture-key' });
    },
  );
  const parent = await compose([{ id: resolver.manifest.id }], [resolver], { scope: 'process' });
  try {
    const definition = installed.catalog.find((plugin) => plugin.manifest.id === ID);
    expect(definition, `${ID} must be installed by the production catalog`).toBeDefined();
    const graph = await compose(
      [
        {
          id: ID,
          config: {
            binding: { calibrationLabel: 'collections-en-2026-09' },
            credentialRef: { credentialId: 'fixture' },
          },
        },
      ],
      [definition!],
      { scope: 'session', parent, workspaceId: 'workspace', net: createFixtureNet([]) },
    );
    try {
      const port = graph.get(Cap.decision);
      expect(port).toBeDefined();
      expect(typeof (port as DecisionPort).decide).toBe('function');
    } finally {
      await graph.dispose();
    }
  } finally {
    await parent.dispose();
  }
});

it('refuses to compose when the binding names NO calibration label', async () => {
  const installed = await loadDistribution({ role: 'gateway', profile: 'compose', env: {} });
  const definition = installed.catalog.find((plugin) => plugin.manifest.id === ID);
  const resolver = definePlugin(
    {
      id: 'p1-decision-test-secrets-2',
      version: '0.1.0',
      contractVersion: 1,
      scope: 'process',
      provides: [Cap.secrets],
      requires: [],
      configSchema: { type: 'object' },
      secretFields: [],
    },
    (ctx) => {
      ctx.provide(Cap.secrets, { resolve: async () => 'fixture-key' });
    },
  );
  const parent = await compose([{ id: resolver.manifest.id }], [resolver], { scope: 'process' });
  try {
    await expect(
      compose(
        [{ id: ID, config: { binding: {}, credentialRef: { credentialId: 'fixture' } } }],
        [definition!],
        { scope: 'session', parent, workspaceId: 'workspace', net: createFixtureNet([]) },
      ),
    ).rejects.toThrow(/calibrationLabel/);
  } finally {
    await parent.dispose();
  }
});
