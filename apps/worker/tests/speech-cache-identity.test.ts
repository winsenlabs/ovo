import { describe, expect, it } from 'vitest';
import { MULAW_8K, PCM16_16K } from '@winsendotai/ovo-contracts';
import { speechBindingRevision, speechCacheIdentity } from '../src/speech-cache-identity.ts';
import { fixtureRelease, RecordingTts } from './speech-cache-harness.ts';

type Release = ReturnType<typeof fixtureRelease>;

function withBinding(patch: (binding: Record<string, unknown>) => void): Release {
  const release = fixtureRelease({ speechCache: { enabled: true } });
  const tts = release.selections!.tts!;
  const config = structuredClone(tts.binding!.config);
  patch(config);
  return {
    ...release,
    selections: { tts: { ...tts, binding: { ...tts.binding!, config } } },
  };
}

describe('speech cache identity (TTS-13)', () => {
  const base = speechBindingRevision(fixtureRelease({}));

  it.each([
    ['voice', (config: Record<string, unknown>) => (config.voice = 'ZUrEGyu8GFMwnHbvLhv2')],
    ['model', (config: Record<string, unknown>) => (config.model = 'eleven_flash_v2_5')],
    ['speed', (config: Record<string, unknown>) => (config.speed = 1.1)],
    ['instructions', (config: Record<string, unknown>) => (config.instructions = 'Warm, calm')],
    [
      'voice settings',
      (config: Record<string, unknown>) =>
        (config.voiceSettings = { stability: 0.5, similarityBoost: 0.8 }),
    ],
    ['language', (config: Record<string, unknown>) => (config.languageCode = 'hi')],
    ['normalization', (config: Record<string, unknown>) => (config.applyTextNormalization = 'off')],
    ['seed', (config: Record<string, unknown>) => (config.seed = 7)],
    [
      'pronunciation dictionary',
      (config: Record<string, unknown>) =>
        (config.pronunciationDictionaries = [{ id: 'lenders', version: '3' }]),
    ],
  ])('changes when the binding %s changes', (_field, patch) => {
    expect(speechBindingRevision(withBinding(patch)).revision).not.toBe(base.revision);
  });

  it('changes with the pinned plugin version and its row config', () => {
    const release = fixtureRelease({});
    const tts = release.selections!.tts!;
    const upgraded = { ...release, selections: { tts: { ...tts, version: '1.1.0' } } };
    const rowConfig = { ...release, selections: { tts: { ...tts, config: { voice: 'other' } } } };
    expect(speechBindingRevision(upgraded).revision).not.toBe(base.revision);
    expect(speechBindingRevision(rowConfig).revision).not.toBe(base.revision);
  });

  it('ignores label-only changes: credential rotation, fingerprints and timestamps', () => {
    const release = fixtureRelease({});
    const tts = release.selections!.tts!;
    const rotated = {
      ...release,
      selections: {
        tts: {
          ...tts,
          binding: {
            ...tts.binding!,
            credentialId: 'credential-2',
            fingerprint: 'fp-2',
            updatedAt: '2026-10-05T00:00:00.000Z',
          },
        },
      },
    };
    expect(speechBindingRevision(rotated)).toEqual(base);
  });

  it('has no "legacy" fallback: an unbound release is marked non-persistent', () => {
    const unbound = fixtureRelease({}, { selections: {} });
    const result = speechBindingRevision(unbound);
    expect(result.persistent).toBe(false);
    expect(result.revision).not.toContain('legacy');
    const legacyBinding = fixtureRelease(
      {},
      {
        selections: {},
        providerBindings: {
          tts: {
            id: 'binding-1',
            workspaceId: 'workspace-a',
            label: 'Voice',
            provider: 'fixture',
            environment: 'test',
            credentialId: 'credential-1',
            config: { voice: 'a' },
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
          } as never,
        },
      },
    );
    expect(speechBindingRevision(legacyBinding).persistent).toBe(true);
  });

  it('keys the provider identity, the negotiated format and the release language', () => {
    const release = fixtureRelease({ language: 'en-IN' });
    const tts = new RecordingTts(false, 'provider-rev-2');
    const mulaw = speechCacheIdentity(release, tts, MULAW_8K).binding;
    const pcm = speechCacheIdentity(release, tts, PCM16_16K).binding;
    expect(mulaw).toMatchObject({
      workspaceId: 'workspace-a',
      provider: 'fixture',
      voice: 'monika',
      locale: 'en-IN',
      codec: 'mulaw',
      sampleRate: 8000,
      optionsRevision: 'provider-rev-2',
    });
    expect(pcm.codec).not.toBe(mulaw.codec);
  });
});
