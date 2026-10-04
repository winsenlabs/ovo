import {
  MULAW_8K,
  bytesPerSecond,
  sameFormat,
  type AudioFormat,
  type SpeechCapabilities,
  type SpeechToText,
  type SttEvent,
  type SttSession,
  type TextToSpeech,
  type UsageMeter,
} from '@winsendotai/ovo-contracts';
import { speechBytes } from './audio-gen.ts';

export interface ScriptedSttSession {
  readonly sessionId: string;
  readonly format: AudioFormat;
  readonly writes: readonly Uint8Array[];
  readonly state: 'open' | 'finished' | 'cancelled';
  readonly usage: readonly UsageMeter[];
  emit(event: SttEvent): void;
  /** speech-start, word-by-word interims, one final, speech-end and end-of-turn. */
  say(text: string, options?: { interims?: boolean; endOfTurn?: boolean }): void;
}

export interface ScriptedStt extends SpeechToText {
  readonly sessions: readonly ScriptedSttSession[];
  /** Resolves with the n-th started session (0-based). */
  session(n?: number): Promise<ScriptedSttSession>;
}

/** An in-memory STT the test drives directly: no network, usage emitted exactly once. */
export function createScriptedStt(
  options: { capabilities?: Partial<SpeechCapabilities>; provider?: string } = {},
): ScriptedStt {
  const provider = options.provider ?? 'scripted';
  const sessions: ScriptedSttSession[] = [];
  const waiters: { n: number; resolve: (s: ScriptedSttSession) => void }[] = [];
  const capabilities: SpeechCapabilities = {
    inputFormats: [MULAW_8K],
    languages: ['*'],
    interim: true,
    wordTimestamps: false,
    turnSignals: ['speech-start', 'speech-end', 'end-of-turn'],
    forceEndpoint: true,
    ...options.capabilities,
  };
  return {
    capabilities,
    sessions,
    session(n = 0) {
      const existing = sessions[n];
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push({ n, resolve }));
    },
    async start(input) {
      const writes: Uint8Array[] = [];
      const usage: UsageMeter[] = [];
      let state: ScriptedSttSession['state'] = 'open';
      let bytes = 0;
      let segment = 0;
      let revision = 0;
      const emitUsage = () => {
        if (usage.length) return;
        const meter: UsageMeter = {
          provider,
          operation: 'stt',
          unit: 'audio_seconds',
          quantity: (bytes / bytesPerSecond(input.format)).toFixed(3),
          state: 'estimated',
          requestId: `${provider}:${input.sessionId}:1`,
          elapsedMs: 0,
        };
        usage.push(meter);
        input.onUsage(meter);
      };
      const scripted: ScriptedSttSession = {
        sessionId: input.sessionId,
        format: input.format,
        writes,
        usage,
        get state() {
          return state;
        },
        emit(event) {
          if (state === 'open') input.onEvent(event);
        },
        say(text, sayOptions = {}) {
          const words = text.split(/\s+/).filter(Boolean);
          const segmentId = `${input.sessionId}:${segment++}`;
          scripted.emit({ type: 'speech-start' });
          if (sayOptions.interims !== false)
            for (let i = 1; i < words.length; i += 1)
              scripted.emit({
                type: 'transcript',
                segment: {
                  segmentId,
                  revision: ++revision,
                  text: words.slice(0, i).join(' '),
                  stability: 'interim',
                },
              });
          scripted.emit({
            type: 'transcript',
            segment: { segmentId, revision: ++revision, text, stability: 'final' },
          });
          scripted.emit({ type: 'speech-end' });
          if (sayOptions.endOfTurn !== false) scripted.emit({ type: 'end-of-turn' });
        },
      };
      const session: SttSession = {
        async write(frame) {
          if (state !== 'open') throw new Error('STT session is closed');
          writes.push(frame);
          bytes += frame.byteLength;
        },
        async forceEndpoint() {},
        async finish() {
          if (state !== 'open') return;
          state = 'finished';
          emitUsage();
        },
        async cancel() {
          if (state !== 'open') return;
          state = 'cancelled';
          emitUsage();
        },
      };
      input.signal.addEventListener('abort', () => void session.cancel('aborted'), { once: true });
      sessions.push(scripted);
      for (const waiter of waiters.splice(0))
        if (sessions[waiter.n]) waiter.resolve(sessions[waiter.n]!);
        else waiters.push(waiter);
      return session;
    },
  };
}

export interface ScriptedTtsOptions {
  outputFormats?: readonly AudioFormat[];
  /** Audio length per character of text. */
  msPerChar?: number;
  minMs?: number;
  chunkMs?: number;
  provider?: string;
}

export interface ScriptedTts extends TextToSpeech {
  readonly texts: readonly string[];
  readonly usage: readonly UsageMeter[];
}

/** An in-memory TTS: speech-like audio sized to the text, chunked, abortable, usage once per call. */
export function createScriptedTts(options: ScriptedTtsOptions = {}): ScriptedTts {
  const provider = options.provider ?? 'scripted';
  const formats = options.outputFormats ?? [MULAW_8K];
  const texts: string[] = [];
  const usage: UsageMeter[] = [];
  let requests = 0;
  return {
    texts,
    usage,
    capabilities: {
      outputFormats: formats,
      languages: ['*'],
      interim: false,
      wordTimestamps: false,
      turnSignals: [],
      forceEndpoint: false,
    },
    cacheIdentity: (format, voice) => ({
      provider,
      model: 'scripted-tts',
      voice: voice ?? 'default',
      revision: `${provider}-${format.encoding}-${format.sampleRate}-v1`,
    }),
    async *synthesize(input) {
      if (!formats.some((format) => sameFormat(format, input.format)))
        throw new TypeError('Scripted TTS was asked for a non-native format');
      texts.push(input.text);
      const meter: UsageMeter = {
        provider,
        operation: 'tts',
        unit: 'characters',
        quantity: String(input.text.length),
        state: 'estimated',
        requestId: `${provider}:${input.sessionId}:${++requests}`,
        elapsedMs: 0,
      };
      usage.push(meter);
      input.onUsage(meter);
      const ms = Math.max(options.minMs ?? 40, input.text.length * (options.msPerChar ?? 2));
      const audio = speechBytes(input.format, ms, input.text.length);
      const chunk = Math.max(
        1,
        Math.round((bytesPerSecond(input.format) * (options.chunkMs ?? 20)) / 1000),
      );
      for (let offset = 0; offset < audio.byteLength; offset += chunk) {
        input.signal.throwIfAborted();
        yield audio.slice(offset, offset + chunk);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    },
  };
}
