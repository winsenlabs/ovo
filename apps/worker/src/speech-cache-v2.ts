import {
  Cap,
  type MediaDuplex,
  type SpeechSegment,
  type TextFilter,
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
import {
  BoundedAudioPrefetch,
  storedAudio,
  streamCachedAudio,
} from './session-graph-speech-buffer.ts';
import { SessionSpeechOutput, prefetchSpeech } from './session-graph-speech-output.ts';
import { segmentAudio } from './speech-cache-audio.ts';
import { loadFixedLine } from './speech-cache-fill.ts';
import { speechCacheIdentity, selectedVoice } from './speech-cache-identity.ts';
import { HYBRID_SPEECH_CACHE_PLUGIN_ID, sessionSpeechApprovals } from './speech-cache-runtime.ts';
import {
  SpeechCacheTelemetry,
  type SpeechCacheObserver,
  type SpeechCacheSource,
} from './speech-cache-telemetry.ts';
import { WorkerSpeechClipCache } from './speech-cache-tiers.ts';

/** Session host override for the engine's streaming-output companion. */
export function createV2SpeechCachePlugin(
  release: ReleaseRecord,
  cache: ByteCache,
  observer?: SpeechCacheObserver,
) {
  const policy = release.config.speechCache;
  if (!policy?.enabled) return undefined;
  const tiers = cache instanceof WorkerSpeechClipCache ? cache : undefined;
  const voice = selectedVoice(release);
  return definePlugin(
    {
      id: HYBRID_SPEECH_CACHE_PLUGIN_ID,
      version: '0.1.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'host',
      requires: [Cap.tts, Cap.media, Cap.usage],
      // The speaker's own filters: approvals are matched on exactly the text it will send (TTS-6).
      optional: [Cap.textFilters],
      provides: [Cap.output],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    (ctx) => {
      const tts = ctx.get(Cap.tts) as TextToSpeech;
      const media = ctx.get(Cap.media) as MediaDuplex;
      const usage = ctx.get(Cap.usage) as UsageSink;
      const filters = [...ctx.all(Cap.textFilters).values()] as TextFilter[];
      const transport = legacyFromDuplex(media);
      const player = new CachedMediaAudioPlayer(transport, {
        format: media.format,
        playbackEvidence: media.playbackEvidence,
        allowWeakEvidence:
          release.config.voice?.acknowledgements.includes('weak-playback-evidence'),
      });
      const identity = speechCacheIdentity(release, tts, media.format);
      const allowed = new ApprovedSpeechPolicy(
        sessionSpeechApprovals(release, filters),
        policy.announcement === true && release.config.mode === 'announcement',
      );
      const telemetry = new SpeechCacheTelemetry(observer);
      const workspaceId = release.workspaceId;
      tiers?.sessionStarted(release);
      type TimingPhase = 'text-ready' | 'tts-first-byte' | 'carrier-first-audio';
      let timing:
        ((phase: TimingPhase, segment: SpeechSegment, elapsedMs?: number) => void) | undefined;
      let maxPrefetchBytes = 262_144;
      const synthesize = (segment: SpeechSegment, signal: AbortSignal) =>
        observeFirstByte(
          segmentAudio(tts, {
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
        );
      const live = (segment: SpeechSegment, signal: AbortSignal) =>
        telemetry.track(
          segment,
          'bypass',
          prefetchSpeech(synthesize(segment, signal), signal, maxPrefetchBytes),
        );
      const createAudio = (segment: SpeechSegment, signal: AbortSignal) => {
        if (!allowed.permits(segment.text, segment.kind)) return live(segment, signal);
        const key = createSpeechCacheKey(identity.binding, segment.text);
        const hit = tiers?.lookup(key, workspaceId) ?? l1Hit(cache, key, workspaceId);
        if (hit)
          return telemetry.track(segment, hit.tier, {
            audio: storedAudio(hit.audio, maxPrefetchBytes),
            cancel: () => undefined,
            suffix: 'cache',
          });
        const state: { source: SpeechCacheSource } = { source: 'miss' };
        // Only fixed lines under a complete identity may outlive this process (TTS-8).
        const durable = identity.persistent && allowed.isScripted(segment.text);
        try {
          const stream = streamCachedAudio(cache, {
            key,
            workspaceId,
            signal,
            maxPrefetchBytes,
            onSource: (source) => {
              if (state.source !== 'durable') state.source = source === 'hit' ? 'l1' : source;
            },
            load: (producerSignal, push) =>
              loadFixedLine({
                tiers,
                cache,
                release,
                key,
                durable,
                producerSignal,
                push,
                codec: media.format.encoding,
                sampleRate: media.format.sampleRate,
                maxBytes: tiers?.maxClipBytes ?? 2 * 1024 * 1024,
                fromDurable: () => (state.source = 'durable'),
                // Detached from the caller (critic: barge-in over a first render): the render
                // finishes and is kept even when the session that started it stops listening.
                render: (renderSignal) => synthesize(segment, renderSignal),
              }),
          });
          return telemetry.track(segment, () => state.source, { ...stream, suffix: 'cache' });
        } catch (error) {
          if (!(
            error instanceof CachePendingCapacityError || error instanceof CacheKeyPendingError
          ))
            throw error;
        }
        return live(segment, signal);
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
      ctx.effect(() => () => {
        output.dispose();
        telemetry.summary();
      });
    },
  );
}

function l1Hit(cache: ByteCache, key: string, workspaceId: string) {
  const audio = cache.get(key, workspaceId);
  return audio ? { audio, tier: 'l1' as const } : undefined;
}
