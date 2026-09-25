import {
  Cap,
  MULAW_8K,
  type MediaDuplex,
  type SpeechOutput,
  type SpeechSegment,
  type TextToSpeech,
  type UsageSink,
} from '@winsendotai/ovo-contracts';
import type { ByteCache } from '@winsendotai/ovo-plugin-cache';
import { legacyFromDuplex, ttsAsLegacy } from '@winsendotai/ovo-plugin-kit';
import { createSpeechCacheKey, ApprovedSpeechPolicy } from '@winsendotai/ovo-plugin-speech-cache';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { StreamingMediaSpeechOutput } from '@winsendotai/ovo-plugin-voice';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { CachedMediaAudioPlayer } from './cached-media-player.ts';
import { approvedSpeechPhrases, HYBRID_SPEECH_CACHE_PLUGIN_ID } from './speech-cache-runtime.ts';

/** Session host override for the engine's streaming-output companion. */
export function createV2SpeechCachePlugin(release: ReleaseRecord, cache: ByteCache) {
  const policy = release.config.speechCache;
  if (!policy?.enabled) return undefined;
  const selection = release.selections?.tts;
  const voice = selectedVoice(release);
  return definePlugin(
    {
      id: HYBRID_SPEECH_CACHE_PLUGIN_ID,
      version: '0.1.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'host',
      requires: [Cap.tts, Cap.media, Cap.usage],
      provides: [Cap.output],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    (ctx) => {
      const tts = ctx.get(Cap.tts) as TextToSpeech;
      const media = ctx.get(Cap.media) as MediaDuplex;
      const usage = ctx.get(Cap.usage) as UsageSink;
      const transport = legacyFromDuplex(media);
      const streaming = new StreamingMediaSpeechOutput(
        ttsAsLegacy(tts, { language: release.config.language, onUsage: usage }),
        transport,
        { voice, playbackEvidence: media.playbackEvidence },
      );
      const player = new CachedMediaAudioPlayer(transport, {
        playbackEvidence: media.playbackEvidence,
      });
      const identity = tts.cacheIdentity(MULAW_8K, voice);
      const cacheKey = {
        workspaceId: release.workspaceId,
        provider: identity.provider,
        bindingVersion:
          selection?.binding?.fingerprint ??
          selection?.binding?.updatedAt ??
          selection?.version ??
          'legacy',
        model: identity.model,
        voice: identity.voice,
        locale: release.config.language,
        codec: 'audio/x-mulaw',
        sampleRate: 8_000,
        pronunciation: 'default',
        prosodyRevision: 'default',
        optionsRevision: identity.revision,
      };
      const allowed = new ApprovedSpeechPolicy(
        approvedSpeechPhrases(release.config),
        policy.announcement === true && release.config.mode === 'announcement',
      );
      const active = new Map<number, SpeechOutput>();
      const cached: SpeechOutput = {
        async play(segment, options) {
          const key = createSpeechCacheKey(cacheKey, segment.text);
          const audio = await cache.getOrLoad({
            key,
            workspaceId: release.workspaceId,
            signal: options.signal,
            load: async (signal) => {
              const chunks: Uint8Array[] = [];
              let bytes = 0;
              for await (const chunk of tts.synthesize({
                sessionId: media.sessionId,
                text: segment.text,
                format: MULAW_8K,
                language: release.config.language,
                voice,
                kind: segment.kind,
                signal,
                onUsage: usage,
              })) {
                bytes += chunk.byteLength;
                if (bytes > 2 * 1024 * 1024) throw new Error('Cached speech exceeds 2 MiB');
                chunks.push(chunk);
              }
              const joined = new Uint8Array(bytes);
              let offset = 0;
              for (const chunk of chunks) {
                joined.set(chunk, offset);
                offset += chunk.byteLength;
              }
              return joined;
            },
          });
          return player.play(
            {
              audio: audio.value,
              codec: 'audio/x-mulaw',
              sampleRate: 8_000,
              segment,
            },
            options,
          );
        },
        interrupt: (epoch) => player.interrupt(epoch),
      };
      const output: SpeechOutput = {
        async play(segment: SpeechSegment, options) {
          const chosen = allowed.permits(segment.text, segment.kind) ? cached : streaming;
          active.set(segment.epoch, chosen);
          try {
            return await chosen.play(segment, options);
          } finally {
            if (active.get(segment.epoch) === chosen) active.delete(segment.epoch);
          }
        },
        async interrupt(epoch) {
          await active.get(epoch)?.interrupt(epoch);
        },
      };
      ctx.provide(Cap.output, output);
      ctx.effect(() => () => {
        player.dispose();
        streaming.dispose();
      });
    },
  );
}

function selectedVoice(release: ReleaseRecord): string | undefined {
  const selected = release.selections?.tts?.config.voice;
  if (typeof selected === 'string' && selected) return selected;
  const legacy = release.providerBindings.tts?.config.voice;
  return typeof legacy === 'string' && legacy ? legacy : undefined;
}
