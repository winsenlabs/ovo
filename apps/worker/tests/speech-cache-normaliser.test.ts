import { describe, expect, it } from 'vitest';
import { composeReleaseTextFilters } from '@winsendotai/ovo-plugin-speech-cache';
import { PluginRegistry } from '@winsendotai/ovo-runtime';
import {
  markdownFilter,
  plugins as voicePlugins,
} from '../../../packages/plugin-voice/src/index.ts';
import { WorkerSpeechCacheRuntime } from '../src/speech-cache-runtime.ts';
import { speakerAddedFilters, withSpeakerFilters } from '../src/speech-cache-speaker-filters.ts';
import { composeCacheOutput, fixtureRelease, RecordingTts } from './speech-cache-harness.ts';

/**
 * Wave 9 D1 review: the speaker adds the speech normaliser to every agent's filters, so a fixed
 * line it rewrites ("Smith & Co" -> "Smith and Co", an en dash range, a date) reaches the cache as the
 * normalised text. The approvals and the pre-render must be keyed on that same text (TTS-6), or
 * the line loses its clip and is synthesised live on every call.
 */
const LINE = 'Smith & Co will call you back, 9am–5pm.';
const SPOKEN = 'Smith and Co will call you back, 9am to 5pm.';

describe('speech cache keys after the speaker normaliser (Wave 9 D1)', () => {
  it('serves a fixed line the normaliser rewrites from cache on the next call', async () => {
    const tts = new RecordingTts();
    const runtime = new WorkerSpeechCacheRuntime();
    const release = fixtureRelease({
      speechCache: { enabled: true },
      language: 'en-IN',
      uncertainty: LINE,
    });
    // As session-graph-runtime takes it: from the distribution's registry, not from plugin-voice.
    const speakerFilters = await speakerAddedFilters(new PluginRegistry(voicePlugins));
    for (let call = 0; call < 2; call += 1) {
      // The agent selected markdown only; the speaker sent the normalised text.
      const session = await composeCacheOutput({
        release,
        cache: runtime.cache,
        tts,
        filters: [markdownFilter],
        speakerFilters,
      });
      try {
        await session.play(SPOKEN, 'response');
      } finally {
        await session.dispose();
      }
    }
    expect(tts.calls.map((call) => call.text)).toEqual([SPOKEN]);
    await runtime.close();
  });

  it('adds nothing the agent already selected, and nothing a distribution lacks', async () => {
    const [normaliser] = await speakerAddedFilters(new PluginRegistry(voicePlugins));
    const own = new Map([[normaliser!.id, normaliser]]);
    expect(withSpeakerFilters(own, [normaliser!])).toEqual([normaliser]);
    expect(await speakerAddedFilters(new PluginRegistry([]))).toEqual([]);
  });

  it('pre-renders through the normaliser when the release does not select it', async () => {
    const composed = await composeReleaseTextFilters(
      { workspaceId: 'workspace-a', config: fixtureRelease({}).config },
      voicePlugins,
      { textFilters: [] },
    );
    try {
      expect(composed.filters.map((filter) => filter.id)).toEqual([
        '@winsendotai/ovo-text-filter-speech-normaliser',
      ]);
    } finally {
      await composed.close();
    }
  });
});
