import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { FIRST_PARTY } from '../src/catalog.ts';
import { loadDistribution } from '../src/load.ts';

describe('router behaviour catalog entry (Wave 15)', () => {
  const entry = FIRST_PARTY.find((item) => item.package === '@winsendotai/ovo-plugin-router');

  it('registers the router package for sessions only and loads its plugin array', async () => {
    expect(entry?.roles).toEqual(['session']);
    const owner = (await import('@winsendotai/ovo-plugin-router')) as { plugins?: unknown };
    expect(Array.isArray(owner.plugins)).toBe(true);
    expect(((await entry!.load()) as { plugins?: unknown }).plugins).toBe(owner.plugins);
  });

  it('is a plugin-kind package the distribution depends on', () => {
    const kinds = JSON.parse(
      readFileSync(new URL('../../../scripts/package-kinds.json', import.meta.url), 'utf8'),
    ) as { kinds: Record<string, string> };
    expect(kinds.kinds['packages/plugin-router']).toBe('plugin');
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(manifest.dependencies['@winsendotai/ovo-plugin-router']).toBe('workspace:*');
  });

  it.each(['api', 'gateway'] as const)(
    'loads the %s distribution with it installed',
    async (role) => {
      const loaded = await loadDistribution({ role, profile: 'compose', env: {} });
      expect(loaded.catalog.length).toBeGreaterThan(0);
    },
  );
});
