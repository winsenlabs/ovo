import { createHash } from 'node:crypto';
import { canonicalJson, type AudioFormat, type TextToSpeech } from '@winsendotai/ovo-contracts';
import type { SpeechSynthesisBinding } from '@winsendotai/ovo-plugin-speech-cache';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';

export interface SpeechCacheIdentity {
  binding: SpeechSynthesisBinding;
  /**
   * True when every audio-affecting setting is visible in the immutable release. Only then may a
   * clip outlive the process (pinned or durable): an identity that cannot see the voice settings
   * cannot notice them change.
   */
  persistent: boolean;
}

type IdentityRelease = Pick<ReleaseRecord, 'workspaceId' | 'config' | 'providerBindings'> & {
  selections?: ReleaseRecord['selections'];
};

/**
 * The binding revision hashes every audio-affecting field the release pins (TTS-13): the selected
 * plugin and its exact version, its row config, and the binding config (voice, model, speed,
 * instructions, voice settings, language, normalization, seed, pronunciation dictionaries...).
 * Labels, credential rotations and timestamps do not change audio and are left out, so editing them
 * does not throw every clip away. The provider's own `cacheIdentity` revision is kept on top.
 */
export function speechBindingRevision(release: IdentityRelease): {
  revision: string;
  persistent: boolean;
} {
  const selection = release.selections?.tts;
  const legacy = selection ? undefined : release.providerBindings.tts;
  // A selection may name its binding by id instead of carrying a snapshot (session-host configFor).
  const bound =
    selection?.binding ??
    (selection?.bindingId
      ? Object.values(release.providerBindings).find((row) => row.id === selection.bindingId)
      : undefined);
  const visible = {
    plugin: selection ? { id: selection.pluginId, version: selection.version } : null,
    rowConfig: selection?.config ?? null,
    binding: bound ? { provider: bound.provider, config: bound.config } : null,
    legacy: legacy
      ? { provider: legacy.provider, pluginId: legacy.pluginId ?? null, config: legacy.config }
      : null,
  };
  const digest = createHash('sha256').update(canonicalJson(visible)).digest('hex');
  return { revision: `tts-binding-v2:${digest}`, persistent: Boolean(selection || legacy) };
}

export function speechCacheIdentity(
  release: IdentityRelease,
  tts: TextToSpeech,
  format: AudioFormat,
): SpeechCacheIdentity {
  const voice = selectedVoice(release);
  const identity = tts.cacheIdentity(format, voice);
  const { revision, persistent } = speechBindingRevision(release);
  return {
    persistent,
    binding: {
      workspaceId: release.workspaceId,
      provider: identity.provider,
      bindingVersion: revision,
      model: identity.model,
      voice: identity.voice,
      locale: release.config.language,
      codec: format.encoding,
      sampleRate: format.sampleRate,
      pronunciation: 'default',
      prosodyRevision: 'default',
      optionsRevision: identity.revision,
    },
  };
}

export function selectedVoice(release: IdentityRelease): string | undefined {
  const selected = release.selections?.tts?.config.voice;
  if (typeof selected === 'string' && selected) return selected;
  const legacy = release.providerBindings.tts?.config.voice;
  return typeof legacy === 'string' && legacy ? legacy : undefined;
}
