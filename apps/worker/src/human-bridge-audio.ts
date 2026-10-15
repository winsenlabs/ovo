import { bytesPerSecond, type AudioFormat } from '@winsendotai/ovo-contracts';
import { DropOldestQueue, RoomFramer } from '@winsendotai/ovo-session-host';
import type { RoomSeat } from './human-contract.ts';
import type { HoldClock } from './hold-player.ts';
import type { SegmentMediaLease } from './segment-media.ts';

/** Room audio waits at most this many 20 ms frames for the carrier; older ones are dropped. */
const OUT_QUEUE_FRAMES = 50;

/**
 * The audio of a human segment (human queue design 7.5): the caller's frames to the room as whole
 * 20 ms frames, whatever the carrier's chunking; the operator's back through a bounded queue
 * that drops its oldest frames, counted, when the carrier falls behind (the link is never
 * cleared). Operator audio that arrives before the lease is live is dropped and counted.
 */
export class BridgeAudio {
  private readonly framer: RoomFramer;
  private readonly out = new DropOldestQueue(OUT_QUEUE_FRAMES);
  private readonly limit: number;
  private live = false;
  private pumping = false;
  private closed = false;
  private early = 0;

  constructor(
    private readonly input: {
      seat: Pick<RoomSeat, 'sendAudio'>;
      lease: Pick<SegmentMediaLease, 'bufferedBytes' | 'sendAudio'>;
      format: AudioFormat;
      clock: HoldClock;
      stop: AbortSignal;
      /** Every frame heard, for the transcriber. */
      heard(side: 'caller' | 'operator', frame: Uint8Array): void;
    },
  ) {
    this.framer = new RoomFramer(input.format);
    this.limit = bytesPerSecond(input.format);
  }

  /** The lease is live: queued and later operator audio flows. */
  attach(): void {
    this.live = true;
    void this.pump();
  }

  close(): void {
    this.closed = true;
    this.out.clear();
  }

  /** Operator frames dropped: the oldest of an over-full queue, and any that came too early. */
  get dropped(): number {
    return this.out.dropped + this.early;
  }

  fromCaller(bytes: Uint8Array): void {
    if (this.closed) return;
    for (const frame of this.framer.push(bytes)) {
      this.input.seat.sendAudio(frame);
      this.input.heard('caller', frame);
    }
  }

  toCaller(frame: Uint8Array): void {
    if (this.closed) return;
    this.input.heard('operator', frame);
    if (!this.live) {
      this.early += 1;
      return;
    }
    this.out.push(frame);
    void this.pump();
  }

  /** Sends queued room audio to the carrier while it keeps up (under a second buffered). */
  private async pump(): Promise<void> {
    if (this.pumping || !this.live) return;
    this.pumping = true;
    try {
      while (this.out.length && !this.closed) {
        if (this.input.lease.bufferedBytes > this.limit) {
          await this.input.clock.sleep(20, this.input.stop);
          continue;
        }
        const frame = this.out.shift()!;
        await this.input.lease.sendAudio(frame).catch(() => this.out.clear());
      }
    } finally {
      this.pumping = false;
    }
  }
}
