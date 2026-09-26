import {
  Cap,
  type MediaDuplex,
  type SpeechSegment,
  type TextToSpeech,
  type UsageSink,
} from '@winsendotai/ovo-contracts';
import {
  CacheKeyPendingError,
  CachePendingCapacityError,
  type ByteCache,
} from '@winsendotai/ovo-plugin-cache';
import { legacyFromDuplex } from '@winsendotai/ovo-plugin-kit';
import { createSpeechCacheKey, ApprovedSpeechPolicy } from '@winsendotai/ovo-plugin-speech-cache';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { CachedMediaAudioPlayer, observeFirstByte } from './cached-media-player.ts';
import { BoundedAudioPrefetch, streamCachedAudio } from './session-graph-speech-buffer.ts';
import { SessionSpeechOutput, prefetchSpeech } from './session-graph-speech-output.ts';
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
      const player = new CachedMediaAudioPlayer(transport, {
        format: media.format,
        playbackEvidence: media.playbackEvidence,
        allowWeakEvidence:
          release.config.voice?.acknowledgements.includes('weak-playback-evidence'),
      });
      const identity = tts.cacheIdentity(media.format, voice);
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
        codec: media.format.encoding,
        sampleRate: media.format.sampleRate,
        pronunciation: 'default',
        prosodyRevision: 'default',
        optionsRevision: identity.revision,
      };
      const allowed = new ApprovedSpeechPolicy(
        approvedSpeechPhrases(release.config),
        policy.announcement === true && release.config.mode === 'announcement',
      );
      type TimingPhase = 'text-ready' | 'tts-first-byte' | 'carrier-first-audio';
      let timing:
        ((phase: TimingPhase, segment: SpeechSegment, elapsedMs?: number) => void) | undefined;
      let maxPrefetchBytes = 262_144;
      const loadCached = (segment: SpeechSegment, signal: AbortSignal) =>
        streamCachedAudio(cache, {
          key: createSpeechCacheKey(cacheKey, segment.text),
          workspaceId: release.workspaceId,
          signal,
          maxPrefetchBytes,
          load: async (producerSignal, push) => {
            const chunks: Uint8Array[] = [];
            let bytes = 0;
            for await (const chunk of observeFirstByte(
              tts.synthesize({
                sessionId: media.sessionId,
                text: segment.text,
                format: media.format,
                language: release.config.language,
                voice,
                kind: segment.kind,
                signal: producerSignal,
                onUsage: usage,
              }),
              () => timing?.('tts-first-byte', segment),
            )) {
              bytes += chunk.byteLength;
              if (bytes > 2 * 1024 * 1024) throw new Error('Cached speech exceeds 2 MiB');
              chunks.push(chunk.slice());
              await push(chunk);
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
      const createAudio = (segment: SpeechSegment, signal: AbortSignal) => {
        if (allowed.permits(segment.text, segment.kind)) {
          try {
            return { ...loadCached(segment, signal), suffix: 'cache' };
          } catch (error) {
            if (!(
              error instanceof CachePendingCapacityError || error instanceof CacheKeyPendingError
            ))
              throw error;
          }
        }
        return prefetchSpeech(
          observeFirstByte(
            tts.synthesize({
              sessionId: media.sessionId,
              text: segment.text,
              format: media.format,
              language: release.config.language,
              voice,
              kind: segment.kind,
              signal,
              onUsage: usage,
            }),
            () => timing?.('tts-first-byte', segment),
          ),
          signal,
          maxPrefetchBytes,
        );
      };
      const output = Object.assign(
        new SessionSpeechOutput(player, createAudio, (segment) =>
          timing?.('carrier-first-audio', segment),
        ),
        {
          configure(options: { markTimeoutMs?: number; maxPrefetchBytes?: number }) {
            player.configure(options);
            if (options.maxPrefetchBytes !== undefined)
              maxPrefetchBytes = new BoundedAudioPrefetch(options.maxPrefetchBytes).maxBytes;
          },
          configureTiming(listener: typeof timing) {
            timing = listener;
          },
        },
      );
      ctx.provide(Cap.output, output);
      ctx.effect(() => () => output.dispose());
    },
  );
}

function selectedVoice(release: ReleaseRecord): string | undefined {
  const selected = release.selections?.tts?.config.voice;
  if (typeof selected === 'string' && selected) return selected;
  const legacy = release.providerBindings.tts?.config.voice;
  return typeof legacy === 'string' && legacy ? legacy : undefined;
}
