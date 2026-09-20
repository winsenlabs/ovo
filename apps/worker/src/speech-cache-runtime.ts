import type { AgentConfig } from '@winsendotai/ovo-contracts';
import {
  BoundedByteCache,
  type ByteCache,
  type ByteCacheLimits,
} from '@winsendotai/ovo-plugin-cache';
import {
  ApprovedSpeechPolicy,
  CachedSpeechOutput,
  type ApprovedSpeechPhrase,
  type NormalizedTts,
  type SpeechCacheTelemetry,
} from '@winsendotai/ovo-plugin-speech-cache';
import { PROVIDER_SERVICE_KEYS, type OpenAiTtsBinding } from '@winsendotai/ovo-plugin-providers';
import { definePlugin, type PluginDefinition } from '@winsendotai/ovo-runtime';
import {
  STREAMING_VOICE_SERVICE_KEYS,
  StreamingMediaSpeechOutput,
  VOICE_SERVICE_KEYS,
  type SpeechOutput,
  type SpeechOutputResult,
  type SpeechSegment,
  type StreamingTts,
  type VoiceMediaTransport,
} from '@winsendotai/ovo-plugin-voice';
import { CachedMediaAudioPlayer } from './cached-media-player.ts';

export const HYBRID_SPEECH_CACHE_PLUGIN_ID = '@winsendotai/ovo-worker/hybrid-speech-cache-output';

interface LiveSpeechCacheInput {
  agent: AgentConfig;
  binding: OpenAiTtsBinding;
  cache: ByteCache;
  cachedTts: NormalizedTts;
  streamingTts: StreamingTts;
  media: VoiceMediaTransport;
  emitCache?: (event: Extract<SpeechCacheTelemetry, { type: 'cache' }>) => void;
}

export class WorkerSpeechCacheRuntime {
  readonly cache: ByteCache;

  constructor(limits: ByteCacheLimits = {}) {
    this.cache = new BoundedByteCache(limits);
  }

  createOutputPlugin(input: {
    agent: AgentConfig;
    binding: OpenAiTtsBinding;
    emitCache?: (event: Extract<SpeechCacheTelemetry, { type: 'cache' }>) => void;
  }): PluginDefinition | undefined {
    const policy = input.agent.speechCache;
    if (!policy?.enabled) return undefined;
    const cache = this.cache;
    const binding = structuredClone(input.binding);
    return definePlugin(
      {
        id: HYBRID_SPEECH_CACHE_PLUGIN_ID,
        version: '0.1.0',
        contractVersion: 1,
        scope: 'session',
        requires: [
          PROVIDER_SERVICE_KEYS.cachedTts,
          STREAMING_VOICE_SERVICE_KEYS.tts,
          STREAMING_VOICE_SERVICE_KEYS.media,
        ],
        provides: [VOICE_SERVICE_KEYS.output],
        configSchema: { type: 'object', additionalProperties: false },
        secretFields: [],
      },
      (ctx) => {
        const created = createHybridSpeechOutput({
          agent: input.agent,
          binding,
          cache,
          cachedTts: required(ctx.get(PROVIDER_SERVICE_KEYS.cachedTts), 'cached TTS'),
          streamingTts: required(ctx.get(STREAMING_VOICE_SERVICE_KEYS.tts), 'streaming TTS'),
          media: required(ctx.get(STREAMING_VOICE_SERVICE_KEYS.media), 'media transport'),
          emitCache: input.emitCache,
        });
        ctx.provide(VOICE_SERVICE_KEYS.output, created.output);
        ctx.effect(() => () => created.dispose());
      },
    );
  }

  close(): void {
    this.cache.clear();
  }
}

export function createHybridSpeechOutput(input: LiveSpeechCacheInput): {
  output: SpeechOutput;
  dispose(): void;
} {
  const phrases = approvedSpeechPhrases(input.agent);
  const policy = input.agent.speechCache;
  const player = new CachedMediaAudioPlayer(input.media);
  const cached = new CachedSpeechOutput(
    {
      workspaceId: input.binding.workspaceId,
      provider: 'openai',
      bindingVersion: input.binding.bindingVersion,
      model: input.binding.model,
      voice: input.binding.voice,
      locale: input.agent.locale,
      codec: 'audio/x-mulaw',
      sampleRate: 8_000,
      pronunciation: input.binding.instructions?.trim() || 'default',
      prosodyRevision: `speed:${input.binding.speed}`,
      optionsRevision: 'openai-tts-mulaw-8000-v1',
      announcementMode: policy?.announcement === true && input.agent.mode === 'announcement',
      approvedPhrases: phrases,
    },
    {
      cache: input.cache,
      tts: input.cachedTts,
      player,
      emit: (event) => {
        if (event.type === 'cache') input.emitCache?.(event);
      },
    },
  );
  const streaming = new StreamingMediaSpeechOutput(input.streamingTts, input.media, {
    voice: input.binding.voice,
  });
  const output = new HybridSpeechOutput(
    cached,
    streaming,
    new ApprovedSpeechPolicy(
      phrases,
      policy?.announcement === true && input.agent.mode === 'announcement',
    ),
  );
  return {
    output,
    dispose: () => {
      player.dispose();
      streaming.dispose();
    },
  };
}

export function approvedSpeechPhrases(agent: AgentConfig): ApprovedSpeechPhrase[] {
  const policy = agent.speechCache;
  if (!policy?.enabled) return [];
  const phrases = new Map<string, ApprovedSpeechPhrase>();
  const approveStatic = (text: string | undefined) => {
    if (text?.trim()) phrases.set(`static:${text}`, { text, purpose: 'static-phrase' });
  };
  approveStatic(agent.processing.initial);
  approveStatic(agent.processing.progress);
  for (const tool of agent.tools) {
    approveStatic(tool.processing?.initial);
    approveStatic(tool.processing?.progress);
  }
  if (policy.announcement && agent.mode === 'announcement' && agent.message.trim())
    phrases.set(`announcement:${agent.message}`, {
      text: agent.message,
      purpose: 'announcement',
    });
  return [...phrases.values()];
}

class HybridSpeechOutput implements SpeechOutput {
  private readonly active = new Map<number, SpeechOutput>();

  constructor(
    private readonly cached: SpeechOutput,
    private readonly streaming: SpeechOutput,
    private readonly policy: ApprovedSpeechPolicy,
  ) {}

  async play(
    segment: SpeechSegment,
    options: Parameters<SpeechOutput['play']>[1],
  ): Promise<SpeechOutputResult> {
    const selected = this.policy.permits(segment.text, segment.kind) ? this.cached : this.streaming;
    this.active.set(segment.epoch, selected);
    try {
      return await selected.play(segment, options);
    } finally {
      if (this.active.get(segment.epoch) === selected) this.active.delete(segment.epoch);
    }
  }

  async interrupt(epoch: number): Promise<void> {
    await this.active.get(epoch)?.interrupt(epoch);
  }
}

function required<T>(value: unknown, name: string): T {
  if (!value) throw new Error(`${name} is unavailable`);
  return value as T;
}
