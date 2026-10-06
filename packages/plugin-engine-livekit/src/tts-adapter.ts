import { tts, type APIConnectOptions } from '@livekit/agents';
import type { IncrementalTts, SpeechSegment } from '@winsendotai/ovo-contracts';
import { FrameDecoder } from './codec.ts';
import type { LiveKitPorts } from './types.ts';

type Frame = ReturnType<FrameDecoder['push']>[number];

/**
 * Queues decoded frames with one frame of lookahead, so the last one of an utterance is marked
 * final. Each frame keeps the carrier bytes it was decoded from (see `codec.ts`).
 */
class FrameQueue {
  private pending?: Frame;
  constructor(
    private readonly segment: SpeechSegment,
    private readonly put: (audio: tts.SynthesizedAudio) => void,
  ) {}
  push(frames: Frame[]): void {
    for (const frame of frames) {
      if (this.pending) this.send(this.pending, false);
      this.pending = frame;
    }
  }
  end(): void {
    if (this.pending) this.send(this.pending, true);
    this.pending = undefined;
  }
  private send(frame: Frame, final: boolean): void {
    this.put({ requestId: this.segment.id, segmentId: this.segment.id, frame, final });
  }
}

function synthesisInput(ports: LiveKitPorts, segment: SpeechSegment, signal: AbortSignal) {
  return {
    sessionId: ports.media.sessionId,
    format: ports.media.format,
    language: ports.session.language,
    voice: ports.voice,
    kind: ports.behavior.speechKind?.(segment.text) ?? segment.kind,
    signal,
    onUsage: ports.usage,
  };
}

class OvoChunkedStream extends tts.ChunkedStream {
  label = 'ovo-tts-stream';
  constructor(
    private readonly text: string,
    owner: tts.TTS,
    private readonly ports: LiveKitPorts,
    private readonly segment: SpeechSegment,
    opts?: APIConnectOptions,
    signal?: AbortSignal,
  ) {
    super(text, owner, opts, signal);
  }
  protected async run(): Promise<void> {
    try {
      await this.synthesize();
    } catch (error) {
      if (!this.abortController.signal.aborted) throw error;
    }
  }
  private async synthesize(): Promise<void> {
    const decoder = new FrameDecoder(this.ports.media.format);
    const frames = new FrameQueue(this.segment, (audio) => this.queue.put(audio));
    const signal = this.abortController.signal;
    for await (const bytes of this.ports.tts.synthesize({
      ...synthesisInput(this.ports, this.segment, signal),
      text: this.text,
    })) {
      signal.throwIfAborted();
      frames.push(decoder.push(bytes, this.segment.id));
    }
    frames.push(decoder.finish(this.segment.id));
    frames.end();
  }
}

/**
 * TTS-14: the streaming path. LiveKit feeds the segment's text as it arrives; each flush is one
 * utterance, rendered through the provider's incremental session (`TextToSpeech.open`, the
 * ElevenLabs WebSocket context) when it has one, else synthesised whole. Without this LiveKit
 * wrapped the chunked stream in its own sentence tokenizer and made one provider request per
 * sentence of every segment.
 */
class OvoSynthesizeStream extends tts.SynthesizeStream {
  label = 'ovo-tts-stream';
  constructor(
    owner: tts.TTS,
    private readonly ports: LiveKitPorts,
    private readonly segment: SpeechSegment,
    opts?: APIConnectOptions,
  ) {
    super(owner, opts);
  }
  protected async run(): Promise<void> {
    let text = '';
    let session: { incremental: IncrementalTts; drained: Promise<void> } | undefined;
    try {
      for await (const input of this.input) {
        if (this.abortSignal.aborted) break;
        if (input === tts.SynthesizeStream.FLUSH_SENTINEL) {
          await this.utterance(text, session);
          text = '';
          session = undefined;
          continue;
        }
        if (!input) continue;
        this.markStarted();
        text += input;
        session ??= await this.open();
        session?.incremental.push(input);
      }
      if (text) await this.utterance(text, session);
      this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
    } catch (error) {
      if (!this.abortSignal.aborted) throw error;
    } finally {
      await session?.incremental.close();
    }
  }
  /** An incremental provider session, or undefined when the provider renders only whole text. */
  private async open() {
    const provider = this.ports.tts;
    if (!provider.capabilities.incrementalText || !provider.open) return undefined;
    const incremental = await provider.open(
      synthesisInput(this.ports, this.segment, this.abortSignal),
    );
    const drained = this.drain(incremental.audio);
    // swallow-ok: `utterance` awaits it and gets the rejection; this only marks it handled meanwhile.
    drained.catch(() => undefined);
    return { incremental, drained };
  }
  private async utterance(
    text: string,
    session: { incremental: IncrementalTts; drained: Promise<void> } | undefined,
  ): Promise<void> {
    if (!text.trim()) return;
    if (session) {
      session.incremental.flush();
      await session.drained;
      await session.incremental.close();
      return;
    }
    await this.drain(
      this.ports.tts.synthesize({
        ...synthesisInput(this.ports, this.segment, this.abortSignal),
        text,
      }),
    );
  }
  private async drain(audio: AsyncIterable<Uint8Array>): Promise<void> {
    const decoder = new FrameDecoder(this.ports.media.format);
    const frames = new FrameQueue(this.segment, (synthesized) => this.queue.put(synthesized));
    for await (const bytes of audio) {
      this.abortSignal.throwIfAborted();
      frames.push(decoder.push(bytes, this.segment.id));
    }
    frames.push(decoder.finish(this.segment.id));
    frames.end();
  }
}

export class OvoTts extends tts.TTS {
  label = 'ovo-tts';
  constructor(
    private readonly ports: LiveKitPorts,
    private readonly current: () => SpeechSegment,
  ) {
    super(8000, 1, { streaming: true });
  }
  synthesize(text: string, opts?: APIConnectOptions, signal?: AbortSignal): tts.ChunkedStream {
    return new OvoChunkedStream(text, this, this.ports, this.current(), opts, signal);
  }
  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    return new OvoSynthesizeStream(this, this.ports, this.current(), options?.connOptions);
  }
}
