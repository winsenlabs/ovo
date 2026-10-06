import {
  AgentConfig,
  Cap,
  MULAW_8K,
  type IncrementalTts,
  type MediaDuplex,
  type SpeechOutput,
  type SpeechSegment,
  type SynthesisInput,
  type TextFilter,
  type TextToSpeech,
  type UsageMeter,
} from '@winsendotai/ovo-contracts';
import type { ByteCache } from '@winsendotai/ovo-plugin-cache';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { createV2SpeechCachePlugin } from '../src/speech-cache-v2.ts';
import type { SpeechCacheObserver } from '../src/speech-cache-telemetry.ts';

/** A provider that records every call and can be switched to the incremental (open) path. */
export class RecordingTts implements TextToSpeech {
  readonly calls: { path: 'synthesize' | 'open'; text: string; sessionId: string }[] = [];
  readonly meters: UsageMeter[] = [];
  gate?: Promise<void>;
  failures = 0;
  readonly capabilities: TextToSpeech['capabilities'];

  constructor(
    readonly incremental = false,
    private readonly revision = '1',
  ) {
    this.capabilities = {
      outputFormats: [MULAW_8K],
      languages: ['*'],
      interim: false,
      wordTimestamps: false,
      turnSignals: [],
      forceEndpoint: false,
      incrementalText: incremental,
    } as TextToSpeech['capabilities'];
  }

  cacheIdentity(_format: unknown, voice?: string) {
    return { provider: 'fixture', model: 'tts', voice: voice ?? 'voice', revision: this.revision };
  }

  async *synthesize(input: SynthesisInput): AsyncIterable<Uint8Array> {
    this.calls.push({ path: 'synthesize', text: input.text, sessionId: input.sessionId });
    yield* this.produce(input, input.text);
  }

  async open(input: Omit<SynthesisInput, 'text'>): Promise<IncrementalTts> {
    const texts: string[] = [];
    let flushed!: () => void;
    const ready = new Promise<void>((resolve) => (flushed = resolve));
    const self = this;
    return {
      push: (text) => texts.push(text),
      flush: () => {
        self.calls.push({ path: 'open', text: texts.join(''), sessionId: input.sessionId });
        flushed();
      },
      audio: (async function* () {
        await ready;
        yield* self.produce(input, texts.join(''));
      })(),
      close: async () => undefined,
    };
  }

  private async *produce(input: Omit<SynthesisInput, 'text'>, text: string) {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('provider unavailable');
    }
    yield new Uint8Array(160).fill(text.length % 251);
    if (this.gate) await this.gate;
    input.signal.throwIfAborted();
    yield new Uint8Array(160).fill(text.length % 251);
    const meter: UsageMeter = {
      provider: 'fixture',
      operation: 'tts',
      unit: 'characters',
      quantity: String(text.length),
      state: 'reconciled',
      requestId: `fixture-${this.meters.length + 1}`,
      elapsedMs: 1,
    };
    this.meters.push(meter);
    input.onUsage(meter);
  }
}

export function fixtureMedia() {
  const marks: string[] = [];
  const audio: Uint8Array[] = [];
  const played = new Set<(name: string) => void>();
  const media = {
    sessionId: 'session-1',
    carrierId: 'fixture',
    format: MULAW_8K,
    playbackEvidence: 'carrier-played',
    clearFlushesMarkers: true,
    bufferedBytes: 0,
    async sendAudio(bytes: Uint8Array) {
      audio.push(bytes.slice());
    },
    async mark(name: string) {
      marks.push(name);
      queueMicrotask(() => {
        for (const listener of played) listener(name);
      });
    },
    async clear() {},
    onPlayed(listener: (name: string) => void) {
      played.add(listener);
      return () => played.delete(listener);
    },
    onAudio: () => () => undefined,
    onCleared: () => () => undefined,
    onDtmf: () => () => undefined,
    onClose: () => () => undefined,
    close: async () => undefined,
  } satisfies MediaDuplex;
  return { media, marks, audio };
}

export function fixtureRelease(
  config: Record<string, unknown>,
  patch: Partial<ReleaseRecord> = {},
): ReleaseRecord {
  return {
    id: 'release-1',
    agentId: 'agent-1',
    draftVersion: 1,
    mcpTools: {},
    createdAt: '2026-10-06T00:00:00.000Z',
    createdBy: 'test',
    workspaceId: 'workspace-a',
    config: AgentConfig.parse({ name: 'Cache', mode: 'agent', ...config }),
    providerBindings: {},
    plugins: [],
    selections: {
      tts: {
        pluginId: '@fixture/tts',
        version: '1.0.0',
        config: { voice: 'monika' },
        bindingId: 'binding-tts',
        binding: {
          provider: 'fixture',
          config: { model: 'flash', voice: 'monika', speed: 1 },
          credentialId: 'credential-1',
          fingerprint: 'fp-1',
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      },
    },
    ...patch,
  };
}

export async function composeCacheOutput(input: {
  release: ReleaseRecord;
  cache: ByteCache;
  tts: TextToSpeech;
  filters?: TextFilter[];
  observer?: SpeechCacheObserver;
  usage?: (meter: UsageMeter) => void;
}) {
  const { media, marks, audio } = fixtureMedia();
  const host = definePlugin(
    {
      id: 'fixture-cache-host',
      version: '1.0.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'host',
      requires: [],
      provides: [Cap.tts, Cap.media, Cap.usage],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    (ctx) => {
      ctx.provide(Cap.tts, input.tts);
      ctx.provide(Cap.media, media);
      ctx.provide(Cap.usage, input.usage ?? (() => undefined));
    },
  );
  const filters = (input.filters ?? []).map((filter) =>
    definePlugin(
      {
        id: filter.id,
        version: '1.0.0',
        contractVersion: 2,
        scope: 'session',
        kind: 'text-filter',
        provider: 'ovo',
        requires: [],
        provides: [Cap.textFilters],
        configSchema: { type: 'object', additionalProperties: false },
        secretFields: [],
      },
      (ctx) => {
        ctx.provide(Cap.textFilters, filter);
      },
    ),
  );
  const plugin = createV2SpeechCachePlugin(input.release, input.cache, input.observer)!;
  const composition = await compose(
    [host, ...filters, plugin].map((definition) => ({ id: definition.manifest.id })),
    [host, ...filters, plugin],
    { scope: 'session' },
  );
  const output = composition.get(Cap.output) as SpeechOutput;
  let next = 0;
  const play = (text: string, kind: SpeechSegment['kind'] = 'response', signal?: AbortSignal) => {
    next += 1;
    const segment: SpeechSegment = { id: `s${next}`, text, kind, epoch: next, generatedAt: 0 };
    return output.play(segment, { signal: signal ?? new AbortController().signal });
  };
  return { output, play, marks, audio, dispose: () => composition.dispose() };
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
