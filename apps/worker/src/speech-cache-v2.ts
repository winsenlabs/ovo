import {
  Cap,
  sameFormat,
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
import {
  ReplyStreams,
  warmSessionTts,
} from '@winsendotai/ovo-session-host/speech-adapters/tts-reply-format';
import {
  createSpeechCacheKey,
  ApprovedSpeechPolicy,
  normalizeSpeechText,
} from '@winsendotai/ovo-plugin-speech-cache';
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
import { DEFAULT_SPEECH_CACHE_OPTIONS, type PerCallClipOptions } from './speech-cache-env.ts';
import { speechCacheIdentity, selectedVoice } from './speech-cache-identity.ts';
import { callClipAudio, type CallClips } from './speech-cache-percall.ts';
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
  /** This call's templated lines (TTS-10); checked before any shared tier and never stored there. */
  perCall?: { clips: CallClips; options?: PerCallClipOptions },
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
      const input = (segment: SpeechSegment, signal: AbortSignal) => ({
        sessionId: media.sessionId,
        format: media.format,
        language: release.config.language,
        voice,
        kind: segment.kind,
        signal,
        onUsage: usage,
      });
      // Session start: the first reply finds the provider's connection open (Wave 2 request #2).
      warmSessionTts(tts, media.format, voice);
      // LAT-5: uncached lines of one reply share one provider context. Cached and fixed lines
      // keep rendering on their own, so a stored clip is always exactly its own text.
      const replies = ReplyStreams.for(tts, (segment, open) =>
        segmentAudio(tts, { ...open, text: segment.text }),
      );
      const synthesize = (segment: SpeechSegment, signal: AbortSignal) =>
        observeFirstByte(segmentAudio(tts, { ...input(segment, signal), text: segment.text }), () =>
          timing?.('tts-first-byte', segment),
        );
      const live = (segment: SpeechSegment, signal: AbortSignal) =>
        telemetry.track(
          segment,
          'bypass',
          prefetchSpeech(
            replies
              ? observeFirstByte(replies.audio(segment, input(segment, signal)), () =>
                  timing?.('tts-first-byte', segment),
                )
              : synthesize(segment, signal),
            signal,
            maxPrefetchBytes,
          ),
        );
      // A set rendered for another format (an early render, a different carrier) is not playable.
      const clips =
        perCall && sameFormat(perCall.clips.format, media.format) ? perCall.clips : undefined;
      const perCallOptions = perCall?.options ?? DEFAULT_SPEECH_CACHE_OPTIONS.perCall;
      /** The speaker's text for each templated line → the line as the behaviour renders it. */
      const callLines = new Map(
        (clips?.lines ?? []).map((line) => [
          normalizeSpeechText(filters, line.text, release.config.language),
          line.text,
        ]),
      );
      if (clips) {
        const lines = clips.reserve(
          (line) => perCallOptions.scope === 'all' || line.opening || line.source === 'voicemail',
        );
        void clips.render(
          {
            tts,
            filters,
            language: release.config.language,
            voice,
            sessionId: media.sessionId,
            onUsage: usage,
          },
          lines,
        );
      }
      const fromCall = (segment: SpeechSegment, signal: AbortSignal) => {
        const line = callLines.get(segment.text);
        const clip = line === undefined ? undefined : clips?.get(line);
        if (!clip || clip.failed) return undefined;
        const state: { source: SpeechCacheSource } = { source: 'template' };
        const audio = callClipAudio(
          clip,
          signal,
          perCallOptions.firstByteBudgetMs,
          () => synthesize(segment, signal),
          () => (state.source = 'bypass'),
        );
        return telemetry.track(segment, () => state.source, {
          ...prefetchSpeech(audio, signal, maxPrefetchBytes),
          suffix: 'cache',
        });
      };
      const createAudio = (segment: SpeechSegment, signal: AbortSignal) => {
        const personal = fromCall(segment, signal);
        if (personal) return personal;
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
      const session = new SessionSpeechOutput(player, createAudio, (segment) =>
        timing?.('carrier-first-audio', segment),
      );
      const interrupt = session.interrupt.bind(session);
      const output = Object.assign(session, {
        /** Barge-in closes that reply's provider context only. */
        interrupt(epoch: number) {
          replies?.close(epoch);
          return interrupt(epoch);
        },
        configure(options: { markTimeoutMs?: number; maxPrefetchBytes?: number }) {
          player.configure(options);
          if (options.maxPrefetchBytes !== undefined)
            maxPrefetchBytes = new BoundedAudioPrefetch(options.maxPrefetchBytes).maxBytes;
        },
        configureTiming(listener: typeof timing) {
          timing = listener;
        },
      });
      ctx.provide(Cap.output, output);
      ctx.effect(() => () => {
        // The call's own audio goes with the call (TTS-10): nothing of it outlives the session.
        clips?.discard();
        replies?.dispose();
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
