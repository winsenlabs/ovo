import { describe, expect, it } from 'vitest';
import { AgentConfig, Cap } from '@winsendotai/ovo-contracts';
import { definePlugin, PluginRegistry } from '@winsendotai/ovo-runtime';
import { normalizeAgentConfig } from '../src/normalize.ts';
import { catalog, MULAW, speech } from './compat-support.ts';

// Wave 8: the distribution preselects the telephony audio filter, which engages only on a line
// that hums or rumbles (docs/presets/audio-filter/README.md).

const filter = definePlugin(
  {
    id: 'audio-filter',
    version: '1.0.0',
    contractVersion: 2,
    scope: 'session',
    kind: 'audio-filter',
    provider: 'ovo',
    provides: [Cap.audioFilter],
    requires: [],
    configSchema: { type: 'object' },
    secretFields: [],
  } as never,
  () => undefined,
);
const registry = (installed = true) =>
  new PluginRegistry([
    ...catalog({ stt: { capabilities: { ...speech, inputFormats: [MULAW] } } }),
    ...(installed ? [filter] : []),
  ]);
const config = (voice: Record<string, unknown> = {}) =>
  AgentConfig.parse({
    name: 'A',
    mode: 'agent',
    voice: { stt: { plugin: 'stt', binding: 'b', config: {} }, ...voice },
  });
const defaults = { engine: 'engine', audioFilter: 'audio-filter' };

describe('audio filter preselection (Wave 8)', () => {
  it('selects the default filter for an agent that selects none', () => {
    const normalized = normalizeAgentConfig(config(), registry(), {}, defaults);
    expect(normalized.config.voice?.audioFilter).toEqual({ plugin: 'audio-filter', config: {} });
    expect(normalized.warnings).toEqual([]);
  });

  it("keeps an agent's own filter, and selects none without a default", () => {
    const own = { plugin: 'other-filter', config: { highPassHz: 150 } };
    const chosen = normalizeAgentConfig(config({ audioFilter: own }), registry(), {}, defaults);
    expect(chosen.config.voice?.audioFilter).toEqual(own);
    const none = normalizeAgentConfig(config(), registry(), {}, { engine: 'engine' });
    expect(none.config.voice?.audioFilter).toBeUndefined();
  });

  it('warns rather than fails when the default filter is not installed', () => {
    const normalized = normalizeAgentConfig(config(), registry(false), {}, defaults);
    expect(normalized.config.voice?.audioFilter).toBeUndefined();
    expect(normalized.warnings).toEqual(['Optional audio filter is not installed: audio-filter']);
  });
});
