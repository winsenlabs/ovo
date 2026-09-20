import { describe, expect, it, vi } from 'vitest';
import { AgentConfig, type AgentConfig as AgentConfigType } from '@winsendotai/ovo-contracts';
import { BoundedByteCache } from '@winsendotai/ovo-plugin-cache';
import type { NormalizedTts, SpeechCacheTelemetry } from '@winsendotai/ovo-plugin-speech-cache';
import type { OpenAiTtsBinding } from '@winsendotai/ovo-plugin-providers';
import type {
  SpeechSegment,
  StreamingTts,
  VoiceMediaTransport,
} from '@winsendotai/ovo-plugin-voice';
import {
  WorkerSpeechCacheRuntime,
  approvedSpeechPhrases,
  createHybridSpeechOutput,
} from '../src/speech-cache-runtime.ts';

describe('worker hybrid speech cache runtime', () => {
  it('derives only configured processing phrases and the exact opted-in announcement', () => {
    const config = agent({ enabled: true, announcement: true });
    const phrases = approvedSpeechPhrases(config);

    expect(phrases).toEqual([
      { text: 'Checking now.', purpose: 'static-phrase' },
      { text: 'Still checking.', purpose: 'static-phrase' },
      { text: 'Tool starting.', purpose: 'static-phrase' },
      { text: 'Tool continues.', purpose: 'static-phrase' },
      { text: 'Exact static announcement.', purpose: 'announcement' },
    ]);
    expect(phrases.map((phrase) => phrase.text)).not.toContain('Do not cache this failure.');
    expect(phrases.map((phrase) => phrase.text)).not.toContain('Dynamic FAQ answer.');
  });

  it('generates approved audio once, plays every hit, and preserves dynamic streaming', async () => {
    const media = new FakeMedia();
    const cache = new BoundedByteCache();
    const cachedTts: NormalizedTts = {
      synthesize: vi.fn(async () => ({
        audio: new Uint8Array(320).fill(7),
        usage: {
          provider: 'openai',
          requestId: 'tts-generation-1',
          quantity: '13',
          unit: 'characters',
          state: 'estimated' as const,
        },
      })),
    };
    let streamingCalls = 0;
    const streamingTts: StreamingTts = {
      async *synthesize() {
        streamingCalls += 1;
        yield new Uint8Array(160).fill(9);
      },
    };
    const telemetry: Extract<SpeechCacheTelemetry, { type: 'cache' }>[] = [];
    const created = createHybridSpeechOutput({
      agent: agent({ enabled: true, announcement: true }),
      binding,
      cache,
      cachedTts,
      streamingTts,
      media,
      emitCache: (event) => telemetry.push(event),
    });

    await created.output.play(segment('approved-1', 'Checking now.', 'acknowledgment'), signal());
    await created.output.play(segment('approved-2', 'Checking now.', 'acknowledgment'), signal());
    await created.output.play(segment('dynamic', 'A model or tool result.', 'response'), signal());
    await created.output.play(
      segment('announcement', 'Exact static announcement.', 'response'),
      signal(),
    );
    await created.output.play(
      segment('announcement-hit', 'Exact static announcement.', 'response'),
      signal(),
    );

    expect(cachedTts.synthesize).toHaveBeenCalledTimes(2);
    expect(streamingCalls).toBe(1);
    expect(media.audioFrames).toHaveLength(9);
    expect(media.marks).toHaveLength(5);
    expect(telemetry.map((event) => event.outcome)).toEqual(['miss', 'hit', 'miss', 'hit']);
    created.dispose();
  });

  it('keeps announcement responses streaming unless announcement caching is explicitly enabled', async () => {
    const media = new FakeMedia();
    const cachedTts: NormalizedTts = {
      synthesize: vi.fn(async () => ({
        audio: Uint8Array.of(1),
        usage: {
          provider: 'openai',
          requestId: 'unused',
          quantity: '1',
          unit: 'characters',
          state: 'estimated' as const,
        },
      })),
    };
    let streamed = 0;
    const created = createHybridSpeechOutput({
      agent: agent({ enabled: true, announcement: false }),
      binding,
      cache: new BoundedByteCache(),
      cachedTts,
      streamingTts: {
        async *synthesize() {
          streamed += 1;
          yield Uint8Array.of(2);
        },
      },
      media,
    });

    await created.output.play(
      segment('announcement', 'Exact static announcement.', 'response'),
      signal(),
    );
    expect(streamed).toBe(1);
    expect(cachedTts.synthesize).not.toHaveBeenCalled();
    created.dispose();
  });

  it('keeps the process cache bounded and returns no plugin when policy is disabled', () => {
    const runtime = new WorkerSpeechCacheRuntime({
      maxEntries: 1,
      maxBytes: 4,
      maxEntryBytes: 4,
      maxPending: 1,
    });
    expect(
      runtime.createOutputPlugin({
        agent: agent({ enabled: false }),
        binding,
      }),
    ).toBeUndefined();
    runtime.cache.set('a', 'workspace-a', Uint8Array.of(1));
    runtime.cache.set('b', 'workspace-a', Uint8Array.of(2));
    expect(runtime.cache.stats).toMatchObject({ entries: 1, bytes: 1 });
    runtime.close();
    expect(runtime.cache.stats).toMatchObject({ entries: 0, bytes: 0 });
  });
});

const binding: OpenAiTtsBinding = {
  workspaceId: 'workspace-a',
  bindingVersion: 'binding:v1',
  credentialId: 'credential-a',
  model: 'gpt-4o-mini-tts',
  voice: 'alloy',
  speed: 1,
  requestTimeoutMs: 10_000,
  maxInputCharacters: 10_000,
  maxResponseBytes: 1_000_000,
  maxOutputChunkBytes: 8_192,
};

function agent(policy: { enabled: boolean; announcement?: boolean }): AgentConfigType {
  const parsed = AgentConfig.parse({
    name: 'Cache policy',
    mode: 'announcement',
    message: 'Exact static announcement.',
    speechCache: policy,
    faq: [{ id: 'faq', question: 'Question?', answer: 'Dynamic FAQ answer.' }],
    processing: {
      initial: 'Checking now.',
      progress: 'Still checking.',
      progressAfterMs: 5_000,
      maxProgress: 1,
      failure: 'Do not cache this failure.',
    },
    tools: [
      {
        id: 'lookup',
        description: 'Lookup',
        connector: 'native',
        inputSchema: {},
        effect: 'read',
        processing: {
          initial: 'Tool starting.',
          progress: 'Tool continues.',
          progressAfterMs: 5_000,
          maxProgress: 1,
          failure: 'Tool failed.',
        },
      },
    ],
  });
  return parsed;
}

function segment(id: string, text: string, kind: SpeechSegment['kind']): SpeechSegment {
  return { id, text, kind, epoch: 1, generatedAt: Date.now() };
}

function signal() {
  return { signal: new AbortController().signal };
}

class FakeMedia implements VoiceMediaTransport {
  readonly sessionId = 'session-a';
  readonly bufferedBytes = 0;
  readonly audioFrames: Uint8Array[] = [];
  readonly marks: string[] = [];
  private readonly markListeners = new Set<(name: string) => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();

  async sendAudio(audio: Uint8Array): Promise<void> {
    this.audioFrames.push(audio.slice());
  }
  async sendMark(name: string): Promise<void> {
    this.marks.push(name);
    for (const listener of this.markListeners) listener(name);
  }
  async clear(): Promise<void> {}
  onAudio(): () => void {
    return () => undefined;
  }
  onMark(listener: (name: string) => void): () => void {
    this.markListeners.add(listener);
    return () => this.markListeners.delete(listener);
  }
  onDtmf(): () => void {
    return () => undefined;
  }
  onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  async close(reason: string): Promise<void> {
    for (const listener of this.closeListeners) listener(reason);
  }
}
