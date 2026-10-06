import { describe, expect, it } from 'vitest';
import { LIVEKIT_UNSUPPORTED_AGENT_FEATURES } from '../../plugin-engine-livekit/src/plugin.ts';
import { engineFeatureUnsupported } from '../src/compat/engine-feature-unsupported.ts';
import { data, fixture, withConfig } from './compat-support.ts';

/** The compat fixture with an engine that declares LiveKit's list of ignored agent settings. */
function livekitLike() {
  return fixture({
    engine: {
      capabilities: {
        ...data.engine.capabilities,
        unsupportedAgentFeatures: LIVEKIT_UNSUPPORTED_AGENT_FEATURES,
      },
    },
  });
}

describe('agent settings the selected engine ignores (TTS-14)', () => {
  it('warns about the speech cache and fillers on an engine that does not honour them', () => {
    const input = withConfig(livekitLike(), {
      mode: 'agent',
      speechCache: { enabled: true },
      voice: {
        turnDetector: {
          plugin: 'turn',
          config: { filler: { afterMs: 600, lines: ['One moment.'] } },
        },
      },
    });
    expect(engineFeatureUnsupported(input, 'release')).toEqual([
      expect.objectContaining({
        code: 'engine_capability_missing',
        severity: 'warning',
        slot: 'engine',
        pluginId: 'engine',
        field: 'speechCache.enabled',
      }),
      expect.objectContaining({ field: 'voice.turnDetector.config.filler', severity: 'warning' }),
    ]);
  });

  it('is quiet for settings that are off, and for an engine that declares nothing', () => {
    const off = withConfig(livekitLike(), { mode: 'agent', speechCache: { enabled: false } });
    expect(engineFeatureUnsupported(off, 'live')).toEqual([]);
    const native = withConfig(fixture(), { mode: 'agent', speechCache: { enabled: true } });
    expect(engineFeatureUnsupported(native, 'live')).toEqual([]);
  });
});
