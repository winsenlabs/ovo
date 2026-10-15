import { FrameAggregator } from '@winsendotai/ovo-audio';
import type { AudioFormat } from '@winsendotai/ovo-contracts';

/** Frames of the call's audio are 20 ms: the size a room seat is given (human queue design 4.5). */
export const ROOM_FRAME_MS = 20;

/** Re-frames a carrier's audio, whatever its chunking, into whole 20 ms frames for a room seat. */
export class RoomFramer {
  private readonly aggregator: FrameAggregator;

  constructor(format: AudioFormat) {
    this.aggregator = new FrameAggregator(format, ROOM_FRAME_MS);
  }

  push(bytes: Uint8Array): Uint8Array[] {
    return this.aggregator.push(bytes);
  }

  reset(): void {
    this.aggregator.reset();
  }
}

/**
 * Room audio on its way to the caller, one second deep at most (design 7.5): when the carrier
 * falls behind, the oldest frames are dropped and counted, never the newest, and the link is
 * never cleared. `take` hands out what is queued, oldest first.
 */
export class DropOldestQueue {
  private frames: Uint8Array[] = [];
  dropped = 0;

  constructor(private readonly capacity: number) {}

  get length(): number {
    return this.frames.length;
  }

  push(frame: Uint8Array): void {
    this.frames.push(frame);
    while (this.frames.length > this.capacity) {
      this.frames.shift();
      this.dropped += 1;
    }
  }

  /** The oldest frame, left queued. */
  peek(): Uint8Array | undefined {
    return this.frames[0];
  }

  shift(): Uint8Array | undefined {
    return this.frames.shift();
  }

  clear(): void {
    this.frames = [];
  }
}
