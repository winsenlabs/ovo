import { MULAW_8K, PCM16_16K, PCM16_24K, PCM16_8K } from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { PluginRegistry } from '@winsendotai/ovo-runtime';
import { describe, expect, it } from 'vitest';
import {
  CartesiaTts,
  cartesiaTtsPlugin,
  outputFormat,
  requestFields,
  socketUrl,
  sonicLanguage,
} from '../src/index.ts';
import { VOICE } from './support.ts';

const ID = cartesiaTtsPlugin.manifest.id;
const registry = new PluginRegistry([cartesiaTtsPlugin]);

describe('Cartesia TTS binding (C1)', () => {
  it('accepts the snapshot default and every documented field within range', () => {
    expect(registry.validateBinding(ID, { voiceId: VOICE })).toEqual({ ok: true });
    expect(
      registry.validateBinding(ID, {
        model: 'sonic-3.6',
        voiceId: VOICE,
        language: 'hi',
        normalization: 'en-IN',
        accent: 'standard-hindi',
        speed: 1.5,
        volume: 0.5,
        emotion: 'calm',
        pronunciationDictId: 'dict-lenders',
        maxBufferDelayMs: 0,
        maxContexts: 3,
        connectTimeoutMs: 3000,
        apiVersion: '2026-08-14',
      }),
    ).toEqual({ ok: true });
  });

  it('rejects sunset and beta models, out-of-range settings, other versions and keys', () => {
    for (const bad of [
      {},
      { voiceId: VOICE, model: 'sonic-2' },
      { voiceId: VOICE, model: 'sonic-turbo' },
      { voiceId: VOICE, model: 'sonic-3-2025-10-27' },
      { voiceId: VOICE, model: 'sonic-latest' },
      { voiceId: VOICE, model: 'sonic-preview' },
      { voiceId: VOICE, speed: 0.5 },
      { voiceId: VOICE, volume: 2.5 },
      { voiceId: VOICE, emotion: 'happy' },
      { voiceId: VOICE, maxBufferDelayMs: 5001 },
      { voiceId: VOICE, language: 'xx' },
      { voiceId: VOICE, apiVersion: '2025-04-16' },
      { voiceId: VOICE, apiKey: 'sk_car_not_here' },
    ])
      expect(registry.validateBinding(ID, bad), JSON.stringify(bad)).toMatchObject({ ok: false });
  });

  it('builds the socket URL with the pinned version and raw native formats only', () => {
    expect(socketUrl({})).toBe('wss://api.cartesia.ai/tts/websocket?cartesia_version=2026-08-14');
    expect(outputFormat(MULAW_8K)).toEqual({
      container: 'raw',
      encoding: 'pcm_mulaw',
      sample_rate: 8000,
    });
    expect(outputFormat(PCM16_24K)).toEqual({
      container: 'raw',
      encoding: 'pcm_s16le',
      sample_rate: 24000,
    });
    expect(outputFormat({ encoding: 'alaw', sampleRate: 8000, channels: 1 })).toBeUndefined();
    expect(outputFormat({ encoding: 'pcm_s16le', sampleRate: 22050, channels: 1 })).toBeUndefined();
  });

  it('maps languages case-insensitively, falls back to the base code, refuses the unknown', () => {
    expect(sonicLanguage('en-in')).toBe('en-IN');
    expect(sonicLanguage('hi_IN')).toBe('hi-IN');
    expect(sonicLanguage('as-IN')).toBeUndefined();
    expect(sonicLanguage('en-PH')).toBe('en');
    expect(() =>
      requestFields({ voiceId: VOICE }, { format: MULAW_8K, language: 'as-IN' }),
    ).toThrow(/does not speak as-IN/);
  });

  it('repeats every audio field on each frame, and the binding language wins', () => {
    const fields = requestFields(
      { voiceId: VOICE, language: 'hi', normalization: 'en-IN', speed: 1.1, emotion: 'calm' },
      { format: PCM16_16K, language: 'en-IN' },
    );
    expect(fields).toEqual({
      model_id: 'sonic-3.6-2026-08-27',
      voice: VOICE,
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 },
      language: 'hi',
      normalization: 'en-IN',
      generation_config: { speed: 1.1, emotion: 'calm' },
      max_buffer_delay_ms: 0,
    });
    // `language` and `locale` must never both be set (400).
    expect(fields).not.toHaveProperty('locale');
  });
});

describe('Cartesia TTS cacheIdentity (C1)', () => {
  const tts = (binding: object) =>
    new CartesiaTts(createFixtureNet([]), 'fixture-key', { voiceId: VOICE, ...binding });

  it('pins the snapshot model and resolves defaults before hashing', () => {
    const identity = tts({}).cacheIdentity(MULAW_8K);
    expect(identity).toMatchObject({
      provider: 'cartesia',
      model: 'sonic-3.6-2026-08-27',
      voice: VOICE,
    });
    expect(identity.revision).toMatch(/^cartesia-v1-[0-9a-f]{16}$/);
    expect(tts({ speed: 1, volume: 1, normalization: 'auto' }).cacheIdentity(MULAW_8K)).toEqual(
      identity,
    );
  });

  it('re-keys on the format, the voice and every audio field, never on transport fields', () => {
    const base = tts({});
    const revisions = new Set(
      [MULAW_8K, PCM16_8K, PCM16_16K, PCM16_24K].map(
        (format) => base.cacheIdentity(format).revision,
      ),
    );
    expect(revisions.size).toBe(4);
    expect(base.cacheIdentity(MULAW_8K, 'other-voice').revision).not.toBe(
      base.cacheIdentity(MULAW_8K).revision,
    );
    for (const changed of [
      { model: 'sonic-3.6' },
      { language: 'hi' },
      { normalization: 'off' },
      { accent: 'standard-hindi' },
      { speed: 0.9 },
      { volume: 1.2 },
      { emotion: 'sad' },
      { pronunciationDictId: 'dict-1' },
    ])
      expect(tts(changed).cacheIdentity(MULAW_8K)).not.toEqual(base.cacheIdentity(MULAW_8K));
    for (const same of [{ maxBufferDelayMs: 200 }, { maxContexts: 5 }, { connectTimeoutMs: 900 }])
      expect(tts(same).cacheIdentity(MULAW_8K)).toEqual(base.cacheIdentity(MULAW_8K));
  });
});
