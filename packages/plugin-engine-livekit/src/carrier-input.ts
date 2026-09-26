import { voice } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import type { MediaDuplex } from '@winsendotai/ovo-contracts';
import { FrameDecoder } from './codec.ts';

export class CarrierAudioInput extends voice.AudioInput {
  readonly stats = {
    acceptedFrames: 0,
    acceptedBytes: 0,
    pendingFrames: 0,
    pendingBytes: 0,
    overflows: 0,
  };
  private readonly frames: AudioFrame[] = [];
  private controller!: ReadableStreamDefaultController<AudioFrame>;
  private readonly detach: () => void;
  private closed = false;
  constructor(media: MediaDuplex, overflow: () => void) {
    super();
    const decoder = new FrameDecoder(media.format);
    this.multiStream.addInputStream(
      new ReadableStream<AudioFrame>({
        start: (controller) => {
          this.controller = controller;
        },
        pull: () => this.drain(),
      }) as unknown as Parameters<typeof this.multiStream.addInputStream>[0],
    );
    this.detach = media.onAudio((bytes) => {
      if (this.closed) return;
      this.stats.acceptedFrames++;
      this.stats.acceptedBytes += bytes.length;
      const frames = decoder.push(bytes);
      if (this.frames.length + frames.length > 250) {
        this.stats.overflows++;
        overflow();
        return;
      }
      this.frames.push(...frames);
      this.drain();
    });
  }
  private drain(): void {
    while (this.frames.length && (this.controller.desiredSize ?? 0) > 0)
      this.controller.enqueue(this.frames.shift()!);
    this.stats.pendingFrames = this.frames.length;
    this.stats.pendingBytes = this.frames.reduce((sum, frame) => sum + frame.data.byteLength, 0);
  }
  override async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.detach();
    } catch {}
    this.frames.length = 0;
    this.stats.pendingFrames = this.stats.pendingBytes = 0;
    try {
      this.controller.close();
    } finally {
      await super.close();
    }
  }
}
