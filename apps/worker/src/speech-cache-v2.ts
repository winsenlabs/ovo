import {
  Cap,
  MULAW_8K,
  type MediaDuplex,
  type SpeechOutput,
  type SpeechOutputResult,
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
import {
  BoundedAudioPrefetch,
  CachedMediaAudioPlayer,
  observeFirstByte,
  streamCachedAudio,
  waitForSendSlot,
} from './cached-media-player.ts';
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
        playbackEvidence: media.playbackEvidence,
        allowWeakEvidence:
          release.config.voice?.acknowledgements.includes('weak-playback-evidence'),
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
                format: MULAW_8K,
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
      type Prepared = {
        epoch: number;
        chosen: 'cached' | 'streaming';
        prior: Promise<void>;
        release(): void;
        audio?: AsyncIterable<Uint8Array>;
        cancel?: () => void;
      };
      const prepared = new Map<string, Prepared>();
      const active = new Map<number, Set<Prepared>>();
      let sendTail: Promise<void> = Promise.resolve();
      const reserve = (segment: SpeechSegment, signal: AbortSignal): Prepared => {
        let chosen: Prepared['chosen'] = allowed.permits(segment.text, segment.kind)
          ? 'cached'
          : 'streaming';
        let cached: ReturnType<typeof loadCached> | undefined;
        if (chosen === 'cached') {
          try {
            cached = loadCached(segment, signal);
          } catch (error) {
            if (error instanceof CachePendingCapacityError || error instanceof CacheKeyPendingError)
              chosen = 'streaming';
            else throw error;
          }
        }
        const prior = sendTail;
        let finish!: () => void;
        let released = false;
        sendTail = new Promise<void>((resolve) => (finish = resolve));
        const state: Prepared = {
          epoch: segment.epoch,
          chosen,
          prior,
          release: () => {
            if (released) return;
            released = true;
            signal.removeEventListener('abort', state.release);
            state.cancel?.();
            finish();
          },
          audio: cached?.audio,
          cancel: cached?.cancel,
        };
        signal.addEventListener('abort', state.release, { once: true });
        if (signal.aborted) state.release();
        prepared.set(segment.id, state);
        return state;
      };
      const output: SpeechOutput & {
        configure(options: { markTimeoutMs?: number; maxPrefetchBytes?: number }): void;
        configureTiming(listener: typeof timing): void;
      } = {
        configure(options) {
          player.configure(options);
          if (options.maxPrefetchBytes !== undefined)
            maxPrefetchBytes = new BoundedAudioPrefetch(options.maxPrefetchBytes).maxBytes;
        },
        configureTiming(listener) {
          timing = listener;
        },
        async prepare(segment, signal) {
          if (!prepared.has(segment.id)) reserve(segment, signal);
        },
        async play(segment: SpeechSegment, options): Promise<SpeechOutputResult> {
          if (options.signal.aborted) return { state: 'interrupted', evidence: 'estimated' };
          await output.prepare!(segment, options.signal);
          const state = prepared.get(segment.id)!;
          const epochActive = active.get(segment.epoch) ?? new Set<Prepared>();
          epochActive.add(state);
          active.set(segment.epoch, epochActive);
          try {
            await waitForSendSlot(state.prior, options.signal);
            options.signal.throwIfAborted();
            const playbackOptions = {
              ...options,
              afterSent: state.release,
              report: (phase: 'sent' | 'acknowledged', evidence: 'estimated' | 'confirmed') => {
                if (phase === 'sent') timing?.('carrier-first-audio', segment);
                options.report?.(phase, evidence);
              },
            };
            if (state.chosen === 'streaming') {
              return await player.playStream(
                observeFirstByte(
                  tts.synthesize({
                    sessionId: media.sessionId,
                    text: segment.text,
                    format: MULAW_8K,
                    language: release.config.language,
                    voice,
                    kind: segment.kind,
                    signal: options.signal,
                    onUsage: usage,
                  }),
                  () => timing?.('tts-first-byte', segment),
                ),
                segment,
                playbackOptions,
              );
            }
            return await player.playStream(state.audio!, segment, playbackOptions, 'cache');
          } catch (error) {
            if (options.signal.aborted) return { state: 'interrupted', evidence: 'estimated' };
            throw error;
          } finally {
            state.release();
            prepared.delete(segment.id);
            epochActive.delete(state);
            if (epochActive.size === 0) active.delete(segment.epoch);
          }
        },
        async interrupt(epoch) {
          for (const [id, state] of prepared) {
            if (state.epoch !== epoch) continue;
            state.release();
            prepared.delete(id);
          }
          const current = active.get(epoch);
          if (!current?.size) return;
          const cleared = player.interrupt(epoch);
          sendTail = cleared.catch(() => undefined);
          await cleared;
        },
      };
      ctx.provide(Cap.output, output);
      ctx.effect(() => () => {
        for (const state of prepared.values()) state.release();
        prepared.clear();
        player.dispose();
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
