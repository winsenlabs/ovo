import { describe, expect, it, vi } from 'vitest';
import {
  Cap,
  MULAW_8K,
  PCM16_24K,
  type CarrierControlFactory,
  type SpeechToText,
  type TextToSpeech,
} from '@winsendotai/ovo-contracts';
import {
  PluginRegistry,
  compose,
  definePlugin,
  type PluginDefinition,
} from '@winsendotai/ovo-runtime';
import { deepgramSttBridge } from '../src/legacy/deepgram-stt.ts';
import { openAiLlmBridge } from '../src/legacy/openai-llm.ts';
import { openAiTtsBridge } from '../src/legacy/openai-tts.ts';
import { twilioCarrierBridge } from '../src/legacy/twilio-carrier.ts';
import { storedBinding } from '../src/legacy/support.ts';

function applyContext() {
  const services = new Map<string, unknown>();
  const secret = vi.fn(async () => 'fixture-secret');
  return {
    services,
    secret,
    ctx: {
      secret,
      maybe: () => undefined,
      get: (key: string) => (key === 'ovo.usage-sink' ? () => undefined : undefined),
      provide: (key: string, value: unknown) => {
        services.set(key, value);
        return () => undefined;
      },
    } as unknown as Parameters<PluginDefinition['apply']>[0],
  };
}

describe('legacy provider bridges', () => {
  const credentialRef = { credentialId: 'credential-1' };

  it('resolves the flat row credential reference in real session composition', async () => {
    const resolve = vi.fn(async () => 'fixture-secret');
    const host = definePlugin(
      {
        id: 'fixture-host-services',
        version: '0.1.0',
        contractVersion: 1,
        scope: 'session',
        requires: [],
        provides: [Cap.secrets, Cap.usage],
        configSchema: { type: 'object' },
        secretFields: [],
      },
      (ctx) => {
        ctx.provide(Cap.secrets, { resolve });
        ctx.provide(Cap.usage, () => undefined);
      },
    );
    const composition = await compose(
      [
        { id: host.manifest.id },
        {
          id: deepgramSttBridge.manifest.id,
          config: { binding: { model: 'nova-2' }, credentialRef },
        },
        {
          id: openAiTtsBridge.manifest.id,
          config: { binding: { model: 'tts-1', voice: 'alloy' }, credentialRef },
        },
        {
          id: openAiLlmBridge.manifest.id,
          config: { binding: { model: 'gpt-4o' }, credentialRef },
        },
      ],
      [host, deepgramSttBridge, openAiTtsBridge, openAiLlmBridge],
      {
        scope: 'session',
        workspaceId: 'w',
      },
    );
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(resolve).toHaveBeenCalledWith('w', 'credential-1');
    expect(composition.violations).toEqual([]);
    await composition.dispose();
  });

  it('rejects missing binding snapshots and credential references before loading a factory', () => {
    expect(() => storedBinding({ credentialRef }, 'openai')).toThrow('binding snapshot');
    expect(() => storedBinding({ binding: { model: 'x' } }, 'openai')).toThrow(
      'credential reference',
    );
    expect(() =>
      storedBinding({ binding: { model: 'x' }, credentialRef: { credentialId: '' } }, 'openai'),
    ).toThrow('credential reference');
  });

  it('rejects malformed provider binding schemas at registry validation', () => {
    const registry = new PluginRegistry([deepgramSttBridge, openAiTtsBridge, openAiLlmBridge]);
    expect(registry.validateBinding(deepgramSttBridge.manifest.id, {})).toMatchObject({
      ok: false,
    });
    expect(registry.validateBinding(deepgramSttBridge.manifest.id, { model: 'nova-2' })).toEqual({
      ok: true,
    });
    expect(registry.validateBinding(openAiTtsBridge.manifest.id, { model: 'tts-1' })).toMatchObject(
      { ok: false },
    );
    expect(
      registry.validateBinding(openAiTtsBridge.manifest.id, { model: 'tts-1', voice: 'alloy' }),
    ).toEqual({ ok: true });
    expect(
      registry.validateBinding(openAiLlmBridge.manifest.id, { model: 'gpt-4o', api: 'bad' }),
    ).toMatchObject({ ok: false });
  });

  it('loads Deepgram through the old factory and exposes only its native input format', async () => {
    const { ctx, services, secret } = applyContext();
    await deepgramSttBridge.apply(ctx, { binding: { model: 'nova-2' }, credentialRef });
    const stt = services.get('ovo.stt') as SpeechToText;
    expect(stt.capabilities.inputFormats).toEqual([MULAW_8K]);
    expect(secret).toHaveBeenCalledWith('');
    await expect(
      stt.start({
        sessionId: 's',
        format: PCM16_24K,
        language: 'en',
        signal: new AbortController().signal,
        onEvent: () => undefined,
        onUsage: () => undefined,
      }),
    ).rejects.toThrow('only MULAW_8K');
  });

  it('keeps the OpenAI μ-law revision and varies cache identity by format and voice', async () => {
    const { ctx, services, secret } = applyContext();
    await openAiTtsBridge.apply(ctx, {
      binding: { model: 'tts-1', voice: 'alloy' },
      credentialRef,
    });
    const tts = services.get('ovo.tts-streaming') as TextToSpeech;
    expect(tts.capabilities.outputFormats).toEqual([MULAW_8K]);
    expect(tts.cacheIdentity(MULAW_8K).revision).toBe('openai-tts-mulaw-8000-v1');
    expect(tts.cacheIdentity(MULAW_8K, 'echo')).not.toEqual(tts.cacheIdentity(MULAW_8K, 'alloy'));
    expect(tts.cacheIdentity(PCM16_24K).revision).not.toBe(tts.cacheIdentity(MULAW_8K).revision);
    expect(secret).toHaveBeenCalledWith('');
  });

  it('loads the OpenAI inference factory without sending provider traffic', async () => {
    const { ctx, services, secret } = applyContext();
    await openAiLlmBridge.apply(ctx, { binding: { model: 'gpt-4o' }, credentialRef });
    expect(services.get('ovo.inference')).toHaveProperty('generate');
    expect(secret).toHaveBeenCalledWith('');
  });
});

describe('Twilio carrier bridge', () => {
  it('rejects https, query-bearing and credentialed media URLs before a dial', async () => {
    const { ctx, services } = applyContext();
    await twilioCarrierBridge.apply(ctx, {});
    const factory = services.get('ovo.carrier.control') as CarrierControlFactory;
    const control = factory.create({
      bindingId: 'env',
      pluginId: twilioCarrierBridge.manifest.id,
      workspaceId: 'w',
      config: { accountSid: `AC${'0'.repeat(32)}` },
      secret: 'token',
    });
    const request = {
      requestId: 'r',
      jobId: 'j',
      to: '+15551234567',
      from: '+15557654321',
      media: { url: 'wss://example.com/media', routeParams: {}, format: MULAW_8K },
      callbacks: { status: 'https://example.com/status', answer: 'https://example.com/answer' },
      maxDurationSec: 1800,
    };
    for (const url of [
      'https://example.com/media',
      'wss://example.com/media?sid=1',
      'wss://user:pass@example.com/media',
    ])
      await expect(
        control.dial({ ...request, media: { ...request.media, url } }),
      ).resolves.toMatchObject({
        kind: 'rejected',
        retryable: false,
      });
  });
});
