import { describe, expect, it } from 'vitest';
import {
  Cap,
  MULAW_8K,
  type SecretResolver,
  type TextToSpeech,
  type UsageMeter,
  type UsageSink,
} from '@winsendotai/ovo-contracts';
import { createMarkdownTextFilterPlugin } from '../../../packages/plugin-voice/src/speech/text-filters.ts';
import { definePlugin, type ParentView } from '@winsendotai/ovo-runtime';
import { DEFAULT_SPEECH_CACHE_OPTIONS } from '../src/speech-cache-env.ts';
import { warmReleaseClips } from '../src/speech-cache-prerender.ts';
import { openReleaseSpeech, PrerenderSkipError } from '../src/speech-cache-release-tts.ts';
import { WorkerSpeechClipCache } from '../src/speech-cache-tiers.ts';
import { fixtureRelease } from './speech-cache-harness.ts';

const capabilities = {
  outputFormats: [MULAW_8K],
  languages: ['*'],
  interim: false,
  wordTimestamps: false,
  turnSignals: [],
  forceEndpoint: false,
} as const;

/** A catalog TTS plugin: it sees only its row config and the session services, as in a call. */
function fixtureTtsPlugin(seen: { config?: Record<string, unknown>; texts: string[] }) {
  return definePlugin(
    {
      id: '@fixture/tts',
      version: '1.0.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'tts',
      provider: 'fixture',
      provides: [`${Cap.tts}@2`],
      requires: [Cap.usage, Cap.secrets],
      optional: [],
      configSchema: { type: 'object' },
      secretFields: [],
      capabilities,
      meters: [{ key: 'fixture.tts.characters', unit: 'characters', label: 'Text', role: 'tts' }],
      runtime: { egressHosts: [], modelLicences: [] },
      conformance: ['tts@1'],
    },
    (ctx, config) => {
      seen.config = config as Record<string, unknown>;
      const usage = ctx.get(Cap.usage) as UsageSink;
      ctx.provide(Cap.tts, {
        capabilities,
        cacheIdentity: (_format, voice) => ({
          provider: 'fixture',
          model: 'flash',
          voice: voice ?? '',
          revision: '1',
        }),
        async *synthesize(input) {
          seen.texts.push(input.text);
          yield new Uint8Array(160).fill(7);
          usage({
            provider: 'fixture',
            operation: 'tts',
            unit: 'characters',
            quantity: String(input.text.length),
            state: 'reconciled',
            requestId: `req-${seen.texts.length}`,
            elapsedMs: 1,
          });
        },
      } satisfies TextToSpeech);
    },
  );
}

const parent: ParentView = { keys: new Set(), get: () => undefined, all: () => new Map() };
const secrets = { forAgent: () => ({}) as SecretResolver };

describe('release speech outside a call (TTS-9)', () => {
  it('composes the release TTS and text filters and renders through them', async () => {
    const seen: { config?: Record<string, unknown>; texts: string[] } = { texts: [] };
    const markdown = createMarkdownTextFilterPlugin();
    const release = fixtureRelease(
      { speechCache: { enabled: true }, clarification: 'Could you **repeat** that?' },
      {
        providerBindings: {
          tts: {
            id: 'binding-tts',
            provider: 'fixture',
            pluginId: '@fixture/tts',
            config: { model: 'flash', voice: 'monika', speed: 1 },
            credentialId: 'credential-1',
            updatedAt: '2026-10-02T00:00:00.000Z',
          },
        } as never,
      },
    );
    release.selections = {
      ...release.selections,
      'textFilter:0': {
        pluginId: markdown.manifest.id,
        version: markdown.manifest.version,
        config: {},
      },
    };
    const meters: UsageMeter[] = [];
    const speech = await openReleaseSpeech(release, (meter) => meters.push(meter), {
      catalog: [fixtureTtsPlugin(seen), markdown],
      parent,
      secrets,
    });
    try {
      expect(seen.config).toMatchObject({
        binding: { model: 'flash', voice: 'monika', speed: 1 },
        credentialRef: { credentialId: 'credential-1' },
        voice: 'monika',
        workspaceId: 'workspace-a',
        bindingId: 'binding-tts',
        updatedAt: '2026-10-02T00:00:00.000Z',
      });
      expect(speech.filters.map((filter) => filter.id)).toEqual([markdown.manifest.id]);
      const cache = new WorkerSpeechClipCache();
      const result = await warmReleaseClips(
        {
          release,
          tts: speech.tts,
          filters: speech.filters,
          onUsage: (meter) => meters.push(meter),
          signal: new AbortController().signal,
        },
        { cache, options: { ...DEFAULT_SPEECH_CACHE_OPTIONS.prerender, backoffMs: 0 } },
      );
      expect(result).toMatchObject({ state: 'done', failed: 0 });
      // The key is computed on the speaker's post-filter text, never the raw configured string.
      expect(seen.texts).toContain('Could you repeat that?');
      expect(seen.texts).not.toContain('Could you **repeat** that?');
      expect(meters).toHaveLength(result.rendered);
    } finally {
      await speech.close();
    }
  });

  it('skips releases it cannot render the way a call would', async () => {
    const seen = { texts: [] as string[] };
    const deps = { catalog: [fixtureTtsPlugin(seen)], parent, secrets };
    const unpinned = fixtureRelease({ speechCache: { enabled: true } }, { selections: {} });
    await expect(openReleaseSpeech(unpinned, () => undefined, deps)).rejects.toBeInstanceOf(
      PrerenderSkipError,
    );
    const missingPlugin = fixtureRelease({ speechCache: { enabled: true } });
    await expect(
      openReleaseSpeech(missingPlugin, () => undefined, { ...deps, catalog: [] }),
    ).rejects.toThrow(PrerenderSkipError);
    const missingFilter = fixtureRelease({ speechCache: { enabled: true } });
    missingFilter.selections = {
      ...missingFilter.selections,
      'textFilter:0': { pluginId: '@fixture/not-installed', version: '1.0.0', config: {} },
    };
    await expect(openReleaseSpeech(missingFilter, () => undefined, deps)).rejects.toThrow(
      /text filters not installed/,
    );
  });
});
