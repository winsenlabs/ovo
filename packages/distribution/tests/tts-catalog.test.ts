import { describe, expect, it } from 'vitest';
import { PluginRegistry } from '@winsendotai/ovo-runtime';
import { loadDistribution } from '../src/load.ts';

const ELEVENLABS = '@winsendotai/ovo-tts-elevenlabs';
const OPENAI = '@winsendotai/ovo-provider-openai-tts';

describe('TTS catalog (TTS-3)', () => {
  it.each(['api', 'gateway'] as const)(
    'the %s profile offers ElevenLabs with OpenAI kept as a fallback binding',
    async (role) => {
      const loaded = await loadDistribution({
        role,
        profile: 'compose',
        env: {},
        log: () => undefined,
      });
      const tts = loaded.catalog
        .filter((plugin) => plugin.manifest.contractVersion === 2 && plugin.manifest.kind === 'tts')
        .map((plugin) => plugin.manifest.id);
      expect(tts).toEqual(expect.arrayContaining([ELEVENLABS, OPENAI]));
      expect(loaded.fixtureTemplates[ELEVENLABS]).toBeTypeOf('function');
      expect(new PluginRegistry(loaded.catalog).get(ELEVENLABS)?.manifest).toMatchObject({
        provider: 'elevenlabs',
        ui: { slot: 'tts', vendor: 'ElevenLabs' },
      });
    },
  );
});
