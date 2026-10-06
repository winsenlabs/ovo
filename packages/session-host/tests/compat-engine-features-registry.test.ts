import { describe, expect, it } from 'vitest';
import { LIVEKIT_UNSUPPORTED_AGENT_FEATURES } from '../../plugin-engine-livekit/src/plugin.ts';
import { validateSelections } from '../src/compat/index.ts';
import { data, fixture, withConfig } from './compat-support.ts';

describe('engine feature checks in release validation (TTS-14)', () => {
  it('warns at release, and blocks nothing, for a speech cache on LiveKit', () => {
    const input = withConfig(
      fixture({
        engine: {
          capabilities: {
            ...data.engine.capabilities,
            unsupportedAgentFeatures: LIVEKIT_UNSUPPORTED_AGENT_FEATURES,
          },
        },
      }),
      { mode: 'agent', speechCache: { enabled: true } },
    );
    expect(
      validateSelections(input, 'release').filter((issue) => issue.field === 'speechCache.enabled'),
    ).toEqual([
      expect.objectContaining({ code: 'engine_capability_missing', severity: 'warning' }),
    ]);
  });
});
