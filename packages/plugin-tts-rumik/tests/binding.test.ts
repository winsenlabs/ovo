import { MULAW_8K, PCM16_16K, PCM16_24K, PCM16_8K, meterKey } from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { PluginRegistry } from '@winsendotai/ovo-runtime';
import { describe, expect, it } from 'vitest';
import {
  RUMIK_TTS_METER_KEY,
  RumikTts,
  fixtureTemplates,
  rumikTtsPlugin,
  type RumikTtsBinding,
} from '../src/index.ts';
import { audioFormatOf, billedCharacters, synthesisFields } from '../src/binding.ts';
import { FIXTURE_DESCRIPTION } from '../src/testing.ts';

const ID = rumikTtsPlugin.manifest.id;
const registry = new PluginRegistry([rumikTtsPlugin]);
const valid = (binding: Record<string, unknown>) => registry.validateBinding(ID, binding).ok;
const tts = (binding: RumikTtsBinding) => new RumikTts(createFixtureNet([]), 'k', binding);

describe('R1: Rumik TTS manifest', () => {
  it('is the tts@2 slot for provider rumik, with the documented capabilities and no open()', () => {
    const manifest = rumikTtsPlugin.manifest as unknown as Record<string, unknown>;
    expect(manifest).toMatchObject({
      id: '@winsendotai/ovo-tts-rumik',
      kind: 'tts',
      provider: 'rumik',
      scope: 'session',
      secretFields: [''],
      runtime: { egressHosts: ['silk-api.rumik.ai'] },
      conformance: ['tts@1'],
      capabilities: {
        outputFormats: [MULAW_8K, PCM16_24K],
        languages: ['en', 'en-IN', 'hi', 'hi-IN'],
        incrementalText: false,
        maxChars: 2000,
      },
    });
    const instance = tts({ description: FIXTURE_DESCRIPTION });
    expect('open' in instance).toBe(false);
    expect(instance.openReply).toBeTypeOf('function');
    expect(instance.warm).toBeTypeOf('function');
    expect(fixtureTemplates[ID]).toBeTypeOf('function');
  });

  it('declares the character meter under the key the cost runtime derives', () => {
    const manifest = rumikTtsPlugin.manifest as { meters?: { key: string; unit: string }[] };
    expect(manifest.meters).toEqual([expect.objectContaining({ key: RUMIK_TTS_METER_KEY })]);
    expect(meterKey({ provider: 'rumik', operation: 'tts', unit: 'characters' })).toBe(
      RUMIK_TTS_METER_KEY,
    );
  });

  it('maps only μ-law 8 kHz and PCM16 24 kHz to an audio_format', () => {
    expect(audioFormatOf(MULAW_8K)).toBe('mulaw');
    expect(audioFormatOf(PCM16_24K)).toBe('pcm');
    for (const other of [PCM16_8K, PCM16_16K, { ...MULAW_8K, sampleRate: 16000 as const }])
      expect(audioFormatOf(other)).toBeUndefined();
  });
});

describe('R1: binding schema', () => {
  it('requires a description for mulberry, the default model, and caps it at 300 characters', () => {
    expect(valid({})).toBe(false);
    expect(valid({ model: 'mulberry' })).toBe(false);
    expect(valid({ description: FIXTURE_DESCRIPTION })).toBe(true);
    expect(valid({ description: 'x'.repeat(300) })).toBe(true);
    expect(valid({ description: 'x'.repeat(301) })).toBe(false);
    // Code points, not UTF-16 units: 300 Devanagari letters fit.
    expect(valid({ description: 'आ'.repeat(300) })).toBe(true);
    expect(valid({ description: '   ' })).toBe(false);
    expect(valid({ model: 'muga' })).toBe(true);
  });

  it('takes only the twelve documented speakers and the six muga tones', () => {
    expect(valid({ description: 'd', speaker: 'siya' })).toBe(true);
    expect(valid({ description: 'd', speaker: 'Siya' })).toBe(false);
    expect(valid({ description: 'd', speaker: 'monika' })).toBe(false);
    for (const tone of ['neutral', 'happy', 'excited', 'sad', 'angry', 'whisper'])
      expect(valid({ model: 'muga', defaultTone: tone })).toBe(true);
    expect(valid({ model: 'muga', defaultTone: 'laugh' })).toBe(false);
    expect(valid({ model: 'spider' })).toBe(false);
  });

  it('bounds the sampling fields and rejects unknown keys and keys in the binding', () => {
    const muga = (extra: Record<string, unknown>) => valid({ model: 'muga', ...extra });
    expect(
      muga({
        temperature: 0.7,
        topP: 0.95,
        topK: 50,
        repetitionPenalty: 1.2,
        maxNewTokens: 8000,
        normalization: true,
        transport: 'http',
        httpFallback: false,
        connectTimeoutMs: 1500,
      }),
    ).toBe(true);
    for (const bad of [
      { temperature: 0 },
      { temperature: 2 },
      { topP: 0 },
      { topP: 1.1 },
      { topK: 0 },
      { topK: 1.5 },
      { repetitionPenalty: 0.9 },
      { maxNewTokens: 8001 },
      { normalization: 'yes' },
      { transport: 'grpc' },
      { connectTimeoutMs: 100 },
      { apiKey: 'rk_live_not_here' },
      { audioFormat: 'mulaw' },
    ])
      expect(muga(bad)).toBe(false);
  });

  it('defaults normalization off, and sends it explicitly so Rumik does not normalise again', () => {
    const fields = synthesisFields({ description: 'd' }, 'Rs 2,45,600 baaki hai.');
    expect(fields).toEqual({
      text: 'Rs 2,45,600 baaki hai.',
      description: 'd',
      normalization: false,
    });
    const schema = (rumikTtsPlugin.manifest as { bindingSchema?: unknown }).bindingSchema as {
      properties: Record<string, { default?: unknown }>;
    };
    expect(schema.properties.normalization!.default).toBe(false);
    expect(schema.properties.model!.default).toBe('mulberry');
  });

  it('counts the mulberry description in the billed characters, and not on muga', () => {
    // The pricing page's example: a 7-character text with a 491-character description bills 498.
    expect(billedCharacters({ description: 'd'.repeat(491) }, 'namaste')).toBe(498);
    expect(billedCharacters({ model: 'muga', description: 'ignored' }, '[happy] haan')).toBe(12);
  });
});

describe('R1: cacheIdentity', () => {
  const base: RumikTtsBinding = { description: FIXTURE_DESCRIPTION };

  it('is rumik-<enc>-<rate>-v1-<sha256/16>, per format, with the resolved voice', () => {
    const identity = tts(base).cacheIdentity(MULAW_8K);
    expect(identity).toMatchObject({ provider: 'rumik', model: 'mulberry', voice: 'described' });
    expect(identity.revision).toMatch(/^rumik-mulaw-8000-v1-[0-9a-f]{16}$/);
    expect(tts(base).cacheIdentity(PCM16_24K).revision).toMatch(
      /^rumik-pcm_s16le-24000-v1-[0-9a-f]{16}$/,
    );
    expect(tts({ ...base, speaker: 'ira' }).cacheIdentity(MULAW_8K).voice).toBe('ira');
    expect(tts({ ...base, speaker: 'ira' }).cacheIdentity(MULAW_8K, 'siya').voice).toBe('siya');
    expect(tts({ model: 'muga' }).cacheIdentity(MULAW_8K)).toMatchObject({
      model: 'muga',
      voice: 'muga',
    });
  });

  it('shares clips between an unset field and its documented default', () => {
    const revision = (binding: RumikTtsBinding) => tts(binding).cacheIdentity(MULAW_8K).revision;
    expect(
      revision({
        ...base,
        defaultTone: 'neutral',
        temperature: 0.6,
        topP: 0.95,
        topK: 50,
        repetitionPenalty: 1.2,
        maxNewTokens: 2048,
        normalization: false,
      }),
    ).toBe(revision(base));
  });

  it('ignores transport, fallback and timeouts, which do not change the audio', () => {
    const revision = (binding: RumikTtsBinding) => tts(binding).cacheIdentity(MULAW_8K).revision;
    expect(
      revision({ ...base, transport: 'http', httpFallback: false, connectTimeoutMs: 9000 }),
    ).toBe(revision(base));
  });

  it('limits muga input so the tone prefix still fits the 2000-character request', () => {
    expect(tts(base).capabilities.maxChars).toBe(2000);
    expect(tts({ model: 'muga' }).capabilities.maxChars).toBe(1990);
  });
});
