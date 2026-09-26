import { tts, type APIConnectOptions } from '@livekit/agents';
import type { SpeechSegment } from '@winsendotai/ovo-contracts';
import { FrameDecoder } from './codec.ts';
import type { LiveKitPorts } from './types.ts';

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
    // One source chunk of lookahead; the SDK owns cancellation of this stream.
    let pending: ReturnType<FrameDecoder['push']>[number] | undefined;
    const put = (frame: NonNullable<typeof pending>, final: boolean) =>
      this.queue.put({
        requestId: this.segment.id,
        segmentId: this.segment.id,
        frame,
        final,
      });
    for await (const bytes of this.ports.tts.synthesize({
      sessionId: this.ports.media.sessionId,
      text: this.text,
      format: this.ports.media.format,
      language: this.ports.session.language,
      voice: this.ports.voice,
      kind: this.ports.behavior.speechKind?.(this.segment.text) ?? this.segment.kind,
      signal: this.abortController.signal,
      onUsage: this.ports.usage,
    })) {
      this.abortController.signal.throwIfAborted();
      for (const frame of decoder.push(bytes, this.segment.id)) {
        if (pending) put(pending, false);
        pending = frame;
      }
    }
    for (const frame of decoder.finish(this.segment.id)) {
      if (pending) put(pending, false);
      pending = frame;
    }
    if (pending) put(pending, true);
  }
}
export class OvoTts extends tts.TTS {
  label = 'ovo-tts';
  constructor(
    private readonly ports: LiveKitPorts,
    private readonly current: () => SpeechSegment,
  ) {
    super(8000, 1, { streaming: false });
  }
  synthesize(text: string, opts?: APIConnectOptions, signal?: AbortSignal): tts.ChunkedStream {
    return new OvoChunkedStream(text, this, this.ports, this.current(), opts, signal);
  }
  stream(): tts.SynthesizeStream {
    throw new Error('OVO TTS uses chunked synthesis');
  }
}
