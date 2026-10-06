import { Cap, MULAW_8K, meterKey, type TextToSpeech } from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { PluginRegistry, compose, definePlugin } from '@winsendotai/ovo-runtime';
import { describe, expect, it, vi } from 'vitest';
import {
  ELEVENLABS_TTS_METER_KEY,
  ElevenLabsTts,
  elevenLabsTtsPlugin,
  fixtureTemplates,
} from '../src/index.ts';
import { socketOpen } from '../src/testing.ts';
import { audioFrame, drain, finalFrame, ttsInput, utterance, wsScript } from './support.ts';

const ID = elevenLabsTtsPlugin.manifest.id;

async function withSecrets(run: (parent: Awaited<ReturnType<typeof compose>>) => Promise<void>) {
  const resolve = vi.fn(async () => 'fixture-key');
  const host = definePlugin(
    {
      id: 'fixture-secret-resolver',
      version: '0.1.0',
      contractVersion: 1,
      scope: 'process',
      requires: [],
      provides: [Cap.secrets],
      configSchema: { type: 'object' },
      secretFields: [],
    },
    (ctx) => {
      ctx.provide(Cap.secrets, { resolve });
    },
  );
  const parent = await compose([{ id: host.manifest.id }], [host], { scope: 'process' });
  try {
    await run(parent);
  } finally {
    await parent.dispose();
  }
  return resolve;
}

describe('ElevenLabs TTS registration', () => {
  it('declares the character meter under the key the cost runtime derives', () => {
    const manifest = elevenLabsTtsPlugin.manifest as { meters?: { key: string }[] };
    expect(manifest.meters?.map((meter) => meter.key)).toEqual([ELEVENLABS_TTS_METER_KEY]);
    expect(meterKey({ provider: 'elevenlabs', operation: 'tts', unit: 'characters' })).toBe(
      ELEVENLABS_TTS_METER_KEY,
    );
    expect(fixtureTemplates[ID]).toBeTypeOf('function');
  });

  it('validates bindings: defaults pass, out-of-range voice settings and unknown keys fail', () => {
    const registry = new PluginRegistry([elevenLabsTtsPlugin]);
    expect(registry.validateBinding(ID, {})).toEqual({ ok: true });
    expect(
      registry.validateBinding(ID, {
        model: 'eleven_flash_v2_5',
        voiceId: 'ZUrEGyu8GFMwnHbvLhv2',
        stability: 0.5,
        similarityBoost: 0.8,
        speed: 1,
        pronunciationDictionaries: [{ id: 'lenders', versionId: 'v1' }],
        region: 'in-residency',
      }),
    ).toEqual({ ok: true });
    for (const bad of [
      { speed: 2 },
      { stability: -0.1 },
      { model: 'eleven_v3' },
      { pronunciationDictionaries: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] },
      { languageCode: 'en-IN' },
      { apiKey: 'sk-not-here' },
    ])
      expect(registry.validateBinding(ID, bad)).toMatchObject({ ok: false });
  });

  it('composes with a credential reference and closes its pooled socket when the session ends', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(MULAW_8K),
        ...utterance('ovo-1', 'Hello.', [audioFrame('ovo-1', [1]), finalFrame('ovo-1')]),
      ]),
    ]);
    const resolve = await withSecrets(async (parent) => {
      const composition = await compose(
        [
          {
            id: ID,
            config: { binding: {}, credentialRef: { credentialRef: { credentialId: 'cred-11' } } },
          },
        ],
        [elevenLabsTtsPlugin],
        { scope: 'session', parent, workspaceId: 'workspace-1', net },
      );
      const tts = composition.get(Cap.tts) as TextToSpeech;
      expect(tts).toBeInstanceOf(ElevenLabsTts);
      expect(await drain(tts.synthesize({ ...ttsInput(), text: 'Hello.' }))).toEqual([1]);
      await composition.dispose();
    });
    expect(resolve).toHaveBeenCalledWith('workspace-1', 'cred-11');
    expect(net.log.at(-1)).toMatchObject({ kind: 'ws-close', data: '1000 ' });
    net.assertComplete();
  });
});
