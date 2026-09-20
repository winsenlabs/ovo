import type { ByteCache } from '@winsendotai/ovo-plugin-cache';
import type {
  SpeechOutput,
  SpeechOutputResult,
  SpeechSegment,
} from '@winsendotai/ovo-plugin-voice';
import { createSpeechCacheKey } from './key.ts';
import { ApprovedSpeechPolicy } from './policy.ts';
import type {
  AudioPlayer,
  NativeUsage,
  NormalizedTts,
  SpeechCacheOutputConfig,
  SpeechCacheTelemetrySink,
  TtsSynthesisRequest,
} from './types.ts';

interface SpeechCacheOutputDependencies {
  cache: ByteCache;
  tts: NormalizedTts;
  player: AudioPlayer;
  emit?: SpeechCacheTelemetrySink;
  now?: () => number;
}

/** Session output adapter. Provider and media SDK ownership remains in their own plugins. */
export class CachedSpeechOutput implements SpeechOutput {
  private readonly policy: ApprovedSpeechPolicy;
  private readonly emit: SpeechCacheTelemetrySink;
  private readonly now: () => number;

  constructor(
    private readonly config: SpeechCacheOutputConfig,
    private readonly dependencies: SpeechCacheOutputDependencies,
  ) {
    validateConfig(config);
    this.config = Object.freeze(structuredClone(config));
    this.policy = new ApprovedSpeechPolicy(
      config.approvedPhrases ?? [],
      config.announcementMode ?? false,
    );
    this.emit = dependencies.emit ?? (() => undefined);
    this.now = dependencies.now ?? Date.now;
  }

  async play(
    segment: SpeechSegment,
    options: { signal: AbortSignal },
  ): Promise<SpeechOutputResult> {
    options.signal.throwIfAborted();
    const audio = this.policy.permits(segment.text, segment.kind)
      ? await this.cachedAudio(segment, options.signal)
      : await this.uncachedAudio(segment, options.signal);
    options.signal.throwIfAborted();
    const result = await this.dependencies.player.play(
      {
        audio: audio.slice(),
        codec: this.config.codec,
        sampleRate: this.config.sampleRate,
        segment,
      },
      options,
    );
    for (const usage of result.usage) {
      validateUsage(usage);
      this.emit({
        type: 'usage',
        phase: 'playback',
        segmentId: segment.id,
        at: this.now(),
        usage,
      });
    }
    return { state: result.state, evidence: result.evidence };
  }

  interrupt(epoch: number): Promise<void> {
    return this.dependencies.player.interrupt(epoch);
  }

  private async cachedAudio(segment: SpeechSegment, signal: AbortSignal): Promise<Uint8Array> {
    const request = synthesisRequest(this.config, segment.text);
    const result = await this.dependencies.cache.getOrLoad({
      key: createSpeechCacheKey(this.config, segment.text),
      workspaceId: this.config.workspaceId,
      signal,
      onSource: (outcome) =>
        this.emit({
          type: 'cache',
          outcome,
          segmentId: segment.id,
          kind: segment.kind,
          at: this.now(),
        }),
      load: async (producerSignal) => {
        const generated = await this.dependencies.tts.synthesize(request, {
          signal: producerSignal,
        });
        this.generationUsage(segment.id, generated.usage);
        return generated.audio;
      },
    });
    return result.value;
  }

  private async uncachedAudio(segment: SpeechSegment, signal: AbortSignal): Promise<Uint8Array> {
    this.emit({
      type: 'cache',
      outcome: 'bypass',
      segmentId: segment.id,
      kind: segment.kind,
      at: this.now(),
    });
    const generated = await this.dependencies.tts.synthesize(
      synthesisRequest(this.config, segment.text),
      {
        signal,
      },
    );
    this.generationUsage(segment.id, generated.usage);
    return generated.audio.slice();
  }

  private generationUsage(segmentId: string, usage: NativeUsage): void {
    validateUsage(usage);
    this.emit({
      type: 'usage',
      phase: 'generation',
      segmentId,
      at: this.now(),
      usage: { ...usage, source: 'tts-generation' },
    });
  }
}

function validateUsage(usage: NativeUsage): void {
  if (!usage.provider || !usage.requestId || !usage.unit)
    throw new TypeError('Normalized usage requires provider, requestId, and unit');
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(usage.quantity))
    throw new TypeError('Normalized usage quantity must be a nonnegative decimal string');
  if (usage.state !== 'estimated' && usage.state !== 'reconciled')
    throw new TypeError('Normalized usage state is invalid');
}

function synthesisRequest(config: SpeechCacheOutputConfig, text: string): TtsSynthesisRequest {
  return {
    workspaceId: config.workspaceId,
    provider: config.provider,
    bindingVersion: config.bindingVersion,
    model: config.model,
    voice: config.voice,
    locale: config.locale,
    codec: config.codec,
    sampleRate: config.sampleRate,
    pronunciation: config.pronunciation,
    prosodyRevision: config.prosodyRevision,
    optionsRevision: config.optionsRevision,
    text,
  };
}

function validateConfig(config: SpeechCacheOutputConfig): void {
  for (const field of [
    'workspaceId',
    'provider',
    'bindingVersion',
    'model',
    'voice',
    'locale',
    'codec',
    'pronunciation',
    'prosodyRevision',
    'optionsRevision',
  ] as const)
    if (!config[field]) throw new TypeError(`${field} must not be empty`);
  if (!Number.isSafeInteger(config.sampleRate) || config.sampleRate < 1)
    throw new TypeError('sampleRate must be a positive integer');
}
