import { AgentConfig, Cap, type ReleaseSelections } from '@winsendotai/ovo-contracts';
import { definePlugin, PluginRegistry } from '@winsendotai/ovo-runtime';
import { expect, it } from 'vitest';
import { catalog } from './compat-support.ts';
import { metersFor } from '../src/meters.ts';
import { normalizeAgentConfig } from '../src/normalize.ts';

it('normalizes defaults without mutating the input or aliasing its nested voice config', () => {
  const input = AgentConfig.parse({
    name: 'fixture',
    mode: 'context',
    voice: { textFilters: [], acknowledgements: [] },
  });
  const before = structuredClone(input);
  const normalized = normalizeAgentConfig(
    input,
    new PluginRegistry(catalog()),
    {},
    {
      engine: 'engine',
      textFilters: ['engine'],
    },
  );
  expect(input).toEqual(before);
  expect(normalized.config.voice?.textFilters).toHaveLength(1);
  normalized.config.voice!.textFilters[0]!.config.changed = true;
  expect(input).toEqual(before);
});

it('fails closed when a selected role declares conditional meters but none match', () => {
  const base = catalog().find((plugin) => plugin.manifest.id === 'tts')!;
  const conditional = {
    ...base,
    manifest: {
      ...base.manifest,
      meters: [
        {
          key: 'tts.neural',
          unit: 'characters',
          label: 'Neural',
          role: 'tts',
          when: { field: 'model', in: ['neural'] },
        },
        {
          key: 'tts.basic',
          unit: 'characters',
          label: 'Basic',
          role: 'tts',
          when: { field: 'model', in: ['basic'] },
        },
      ],
    },
  } as typeof base;
  const registry = new PluginRegistry([conditional]);
  const select = (binding?: Record<string, unknown>): ReleaseSelections => ({
    tts: {
      pluginId: 'tts',
      version: '1.0.0',
      config: {},
      ...(binding
        ? {
            binding: {
              provider: 'fixture',
              config: binding,
              credentialId: 'c',
              fingerprint: 'f',
              updatedAt: 't',
            },
          }
        : {}),
    },
  });
  for (const binding of [undefined, {}, { model: 'unknown' }])
    expect(() => metersFor(select(binding), registry, { requiresInput: false })).toThrow(
      'No applicable tts meter',
    );
  expect(
    metersFor(select({ model: 'neural' }), registry, { requiresInput: false }).map(
      (row) => row.meter.key,
    ),
  ).toEqual(['tts.neural']);
  expect(
    metersFor(select({ model: 'basic' }), registry, { requiresInput: false }).map(
      (row) => row.meter.key,
    ),
  ).toEqual(['tts.basic']);

  const unmetered = definePlugin(
    {
      id: 'legacy-tts-unmetered',
      version: '1.0.0',
      contractVersion: 1,
      scope: 'session',
      provides: [Cap.tts],
      requires: [],
      configSchema: { type: 'object' },
      secretFields: [],
    },
    () => undefined,
  );
  expect(
    metersFor(
      { tts: { pluginId: 'legacy-tts-unmetered', version: '1.0.0', config: {} } },
      new PluginRegistry([unmetered]),
      { requiresInput: false },
    ),
  ).toEqual([]);
});
