import { describe, expect, it } from 'vitest';
import { Cap, type SecretResolver } from '@winsendotai/ovo-contracts';
import { createFakeCarrier, FakeClock } from '@winsendotai/ovo-conformance/drivers';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { compose } from '@winsendotai/ovo-runtime';
import { fixtureHostService } from '../src/host-service.ts';

describe('fixture secret isolation', () => {
  it('resolves only explicit synthetic secrets in the selected workspace', async () => {
    const host = fixtureHostService({
      media: createFakeCarrier().duplex,
      clock: new FakeClock(),
      usage: () => undefined,
      transcript: () => undefined,
      workspaceId: 'fixture-workspace',
      fixtureSecrets: { synthetic: 'fixture-value' },
    });
    const graph = await compose([{ id: host.manifest.id }], [host], {
      scope: 'session',
      workspaceId: 'fixture-workspace',
      net: createFixtureNet([]),
      fixtures: true,
      enforcement: 'enforce',
    });
    try {
      const secrets = graph.get(Cap.secrets) as SecretResolver;
      expect(await secrets.resolve('fixture-workspace', 'synthetic')).toBe('fixture-value');
      await expect(secrets.resolve('other-workspace', 'synthetic')).rejects.toThrow(
        'live secrets are disabled',
      );
      await expect(secrets.resolve('fixture-workspace', 'absent')).rejects.toThrow(
        'live secrets are disabled',
      );
    } finally {
      await graph.dispose();
    }
  });
});
