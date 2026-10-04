import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import type * as LK from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { PCM16_8K, type SpeechToText, type TextToSpeech } from '@winsendotai/ovo-contracts';
import { createFakeCarrier, withEgressSentinel } from '@winsendotai/ovo-conformance/drivers';
import { expect, it, vi } from 'vitest';

/** Pinned upstream: @livekit/agents 1.9.0 src/voice/io.ts, stt/stt.ts and tts/tts.ts. */
it('runs the pinned no-room audio path through OVO STT, say, and carrier playout', async () => {
  await withEgressSentinel(
    async (sentinel) => {
      // Import native dependencies only after every network entry point is fenced.
      const lk = await import('@livekit/agents');
      const rtc = await import('@livekit/rtc-node');
      lk.initializeLogger({ pretty: false, level: 'silent' });
      expect(Object.keys(process.env).filter((key) => key.startsWith('LIVEKIT_'))).toEqual([]);
      const carrier = createFakeCarrier({ format: PCM16_8K, playback: 'manual' });
      const turns: string[] = [];
      const trace: string[] = [];
      const writes: Uint8Array[] = [];
      const spoken: string[] = [];
      const ovoStt: SpeechToText = {
        capabilities: {
          inputFormats: [PCM16_8K],
          languages: ['en-US'],
          interim: true,
          wordTimestamps: false,
          turnSignals: ['end-of-turn'],
          forceEndpoint: true,
        },
        async start(input) {
          let emitted = false;
          return {
            async write(bytes) {
              writes.push(bytes.slice());
              if (emitted) return;
              emitted = true;
              input.onEvent({ type: 'speech-start' });
              input.onEvent({
                type: 'transcript',
                segment: {
                  segmentId: 'caller-1',
                  revision: 1,
                  stability: 'final',
                  text: 'hello fixture',
                },
              });
              input.onEvent({ type: 'end-of-turn' });
            },
            async finish() {},
            async cancel() {},
          };
        },
      };
      const ovoTts: TextToSpeech = {
        capabilities: {
          outputFormats: [PCM16_8K],
          languages: ['en-US'],
          interim: false,
          wordTimestamps: false,
          turnSignals: [],
          forceEndpoint: false,
        },
        cacheIdentity: () => ({
          provider: 'fixture',
          model: 'fixture',
          voice: 'fixture',
          revision: '1',
        }),
        async *synthesize(input) {
          expect(input.format).toEqual(PCM16_8K);
          spoken.push(input.text);
          yield new Uint8Array(320).fill(1);
        },
      };

      class CarrierAudioInput extends lk.voice.AudioInput {
        private controller!: ReadableStreamDefaultController<AudioFrame>;
        constructor() {
          super();
          this.multiStream.addInputStream(
            new ReadableStream<AudioFrame>({
              start: (controller) => {
                this.controller = controller;
              },
            }),
          );
        }
        push(frame: AudioFrame) {
          this.controller.enqueue(frame);
        }
      }
      class CarrierAudioOutput extends lk.voice.AudioOutput {
        private pending?: string;
        private segment?: string;
        readonly detachPlayed: () => void;
        constructor() {
          super(8000);
          this.detachPlayed = carrier.duplex.onPlayed((name) => {
            if (this.pending !== name) return;
            this.pending = undefined;
            trace.push('playout-finished');
            this.onPlaybackFinished({ interrupted: false, playbackPosition: 0.02 });
          });
        }
        override async captureFrame(frame: AudioFrame) {
          await super.captureFrame(frame);
          this.segment = String(frame.userdata.segmentId ?? 'spike-segment');
          trace.push('capture');
          await carrier.duplex.sendAudio(
            new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
          );
        }
        override flush() {
          super.flush();
          if (!this.segment) return;
          trace.push('flush');
          this.pending = this.segment;
          this.segment = undefined;
          void carrier.duplex.mark(this.pending);
        }
        clearBuffer() {
          const active = this.pending ?? this.segment;
          this.pending = this.segment = undefined;
          void carrier.duplex.clear();
          if (active) this.onPlaybackFinished({ interrupted: true, playbackPosition: 0 });
        }
      }
      class OvoSpeechStream extends lk.stt.SpeechStream {
        label = 'ovo-spike-stt-stream';
        constructor(owner: LK.stt.STT) {
          super(owner, 8000, { ...lk.DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0 });
        }
        protected async run() {
          const provider = await ovoStt.start({
            sessionId: carrier.duplex.sessionId,
            format: PCM16_8K,
            language: 'en-US',
            signal: this.abortSignal,
            onUsage() {},
            onEvent: (event) => {
              const data: LK.stt.SpeechData = {
                language: lk.asLanguageCode('en-US'),
                text: event.type === 'transcript' ? event.segment.text : 'hello fixture',
                startTime: 0,
                endTime: 0.02,
                confidence: 1,
              };
              const type =
                event.type === 'speech-start'
                  ? lk.stt.SpeechEventType.START_OF_SPEECH
                  : event.type === 'transcript'
                    ? event.segment.stability === 'final'
                      ? lk.stt.SpeechEventType.FINAL_TRANSCRIPT
                      : lk.stt.SpeechEventType.INTERIM_TRANSCRIPT
                    : event.type === 'end-of-turn' || event.type === 'utterance-end'
                      ? lk.stt.SpeechEventType.END_OF_SPEECH
                      : undefined;
              if (type !== undefined) this.queue.put({ type, alternatives: [data] });
            },
          });
          try {
            for await (const frame of this.input) {
              if (typeof frame === 'symbol') continue;
              await provider.write(
                new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
              );
            }
          } finally {
            await provider.cancel('spike complete');
          }
        }
      }
      class OvoStt extends lk.stt.STT {
        label = 'ovo-spike-stt';
        constructor() {
          super({ streaming: true, interimResults: true });
        }
        protected async _recognize(): Promise<LK.stt.SpeechEvent> {
          throw new Error('streaming only');
        }
        stream() {
          return new OvoSpeechStream(this);
        }
      }
      class OvoChunkedStream extends lk.tts.ChunkedStream {
        label = 'ovo-spike-tts-stream';
        constructor(
          private readonly text: string,
          owner: LK.tts.TTS,
          opts?: LK.APIConnectOptions,
          signal?: AbortSignal,
        ) {
          super(text, owner, opts, signal);
        }
        protected async run() {
          for await (const bytes of ovoTts.synthesize({
            sessionId: carrier.duplex.sessionId,
            text: this.text,
            format: PCM16_8K,
            language: 'en-US',
            signal: this.abortController.signal,
            onUsage() {},
          })) {
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const pcm = Int16Array.from({ length: bytes.length / 2 }, (_, i) =>
              view.getInt16(i * 2, true),
            );
            this.queue.put({
              requestId: 'spike-request',
              segmentId: 'spike-segment',
              frame: new rtc.AudioFrame(pcm, 8000, 1, pcm.length, { segmentId: 'spike-segment' }),
              final: true,
            });
          }
        }
      }
      class OvoTts extends lk.tts.TTS {
        label = 'ovo-spike-tts';
        constructor() {
          super(8000, 1, { streaming: false });
        }
        synthesize(text: string, opts?: LK.APIConnectOptions, signal?: AbortSignal) {
          return new OvoChunkedStream(text, this, opts, signal);
        }
        stream(): LK.tts.SynthesizeStream {
          throw new Error('chunked only');
        }
      }
      class OvoAgent extends lk.Agent {
        constructor() {
          super({ instructions: 'Replies come only from OVO Behavior.' });
        }
        override async onUserTurnCompleted(_ctx: LK.llm.ChatContext, message: LK.llm.ChatMessage) {
          turns.push(message.textContent ?? '');
          throw new lk.voice.StopResponse();
        }
      }
      const input = new CarrierAudioInput();
      const output = new CarrierAudioOutput();
      const session = new lk.AgentSession({
        stt: new OvoStt(),
        tts: new OvoTts(),
        vad: null,
        turnHandling: {
          turnDetection: 'stt',
          interruption: { mode: 'vad', minWords: 2 },
          preemptiveGeneration: { enabled: false },
        },
        aecWarmupDuration: null,
        userAwayTimeout: null,
        ttsTextTransforms: null,
        useTtsAlignedTranscript: false,
        expressive: false,
        connOptions: { sttConnOptions: { maxRetry: 0 }, ttsConnOptions: { maxRetry: 0 } },
      });
      session.input.audio = input;
      session.output.audio = output;
      session.output.setTranscriptionEnabled(false);
      try {
        await session.start({ agent: new OvoAgent() });
        expect((session as unknown as { _usingDefaultVad: boolean })._usingDefaultVad).toBe(false);
        expect(session.llm).toBeUndefined();
        input.push(new rtc.AudioFrame(new Int16Array(160).fill(1000), 8000, 1, 160));
        await vi.waitFor(() => expect(turns).toEqual(['hello fixture']), { timeout: 10_000 });
        expect(writes).toHaveLength(1);
        const speech = session.say('Hello from OVO.', {
          addToChatCtx: false,
          allowInterruptions: false,
        });
        await vi.waitFor(() => expect(trace).toContain('flush'), { timeout: 10_000 });
        expect(carrier.log.some((entry) => entry.type === 'mark')).toBe(true);
        expect(trace).not.toContain('playout-finished');
        carrier.drain();
        await speech.waitForPlayout();
        expect(spoken).toEqual(['Hello from OVO.']);
        expect(trace).toEqual(['capture', 'flush', 'playout-finished']);
        expect(sentinel.attempts).toEqual([]);
      } finally {
        await session.close();
        await input.close();
        output.detachPlayed();
      }
    },
    { allowLoopback: false },
  );
}, 60_000);
