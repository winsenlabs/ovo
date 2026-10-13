import { FrameAggregator, msForBytes, silence } from '@winsendotai/ovo-audio';
import type { AudioFormat, Clock } from '@winsendotai/ovo-contracts';

type Timer = Pick<Clock, 'now' | 'setTimeout'>;

/**
 * Ink needs a continuous stream: "If you stop sending audio, the server will wait … your client
 * needs to send silence" (https://docs.cartesia.ai/build-with-cartesia/stt/audio-input.md,
 * retrieved 2026-10-13), and silence is billed anyway (https://docs.cartesia.ai/pricing.md). After
 * KEEPER_GAP_MS without a write the keeper feeds the silence that gap held, then KEEPER_TICK_MS
 * of it at a time until audio comes back.
 */
export const KEEPER_GAP_MS = 200;
export const KEEPER_TICK_MS = 100;
/** A stalled event loop is not made up for with seconds of silence in one go. */
const KEEPER_MAX_FEED_MS = 1_000;

export class SilenceKeeper {
  private lastAudio: number;
  private disarm: () => void = () => undefined;
  private stopped = false;

  constructor(
    private readonly clock: Timer,
    /** Receives the milliseconds of silence to send. */
    private readonly feed: (ms: number) => void,
  ) {
    this.lastAudio = clock.now();
    this.arm(KEEPER_GAP_MS);
  }

  /** Caller audio arrived: the gap starts over. */
  touch(): void {
    if (this.stopped) return;
    this.lastAudio = this.clock.now();
    this.arm(KEEPER_GAP_MS);
  }

  stop(): void {
    this.stopped = true;
    this.disarm();
  }

  private arm(ms: number): void {
    this.disarm();
    this.disarm = this.clock.setTimeout(() => this.fire(), ms);
  }

  private fire(): void {
    if (this.stopped) return;
    const now = this.clock.now();
    const gap = Math.min(KEEPER_MAX_FEED_MS, now - this.lastAudio);
    this.lastAudio = now;
    if (gap > 0) this.feed(gap);
    this.arm(KEEPER_TICK_MS);
  }
}

export type UplinkItem = { audio: Uint8Array } | { text: string };

/**
 * Paces audio to at most `maxRate` times real time, with one frame of headroom: a token bucket in
 * milliseconds of audio that refills at `maxRate` ms per ms and holds at most `burstMs`. Live audio
 * (one 100 ms frame per 100 ms) never waits; the worker's pre-session replay (up to 15 s written at
 * once) drains at 2x by default, since a burst "can overload the server-side buffer"
 * [audio-input.md]. How much burst Ink tolerates is UNCONFIRMED. Text commands queue behind the
 * audio before them and cost nothing.
 */
export class BacklogPacer {
  private readonly queue: UplinkItem[] = [];
  private readonly idle: (() => void)[] = [];
  private tokensMs: number;
  private refilledAt: number;
  private disarm?: () => void;
  private stopped = false;

  constructor(
    private readonly clock: Timer,
    private readonly format: AudioFormat,
    private readonly send: (item: UplinkItem) => void,
    private readonly maxRate = 2,
    private readonly burstMs = 100,
  ) {
    this.tokensMs = burstMs;
    this.refilledAt = clock.now();
  }

  /** Milliseconds of audio waiting to go out. */
  get queuedMs(): number {
    return this.queue.reduce(
      (sum, item) => sum + ('audio' in item ? msForBytes(this.format, item.audio.byteLength) : 0),
      0,
    );
  }

  push(item: UplinkItem): void {
    if (this.stopped) return;
    this.queue.push(item);
    if (!this.disarm) this.pump();
  }

  /** Resolves once everything queued so far has been sent (or the pacer stopped). */
  drained(): Promise<void> {
    if (!this.queue.length || this.stopped) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }

  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    this.disarm?.();
    this.disarm = undefined;
    for (const resolve of this.idle.splice(0)) resolve();
  }

  private pump(): void {
    this.disarm = undefined;
    const now = this.clock.now();
    this.tokensMs = Math.min(this.burstMs, this.tokensMs + (now - this.refilledAt) * this.maxRate);
    this.refilledAt = now;
    while (this.queue.length && !this.stopped) {
      const head = this.queue[0]!;
      const cost = 'audio' in head ? msForBytes(this.format, head.audio.byteLength) : 0;
      const needed = Math.min(cost, this.burstMs);
      if (this.tokensMs + 1e-9 < needed) {
        const wait = Math.ceil((needed - this.tokensMs) / this.maxRate);
        this.disarm = this.clock.setTimeout(() => this.pump(), wait);
        return;
      }
      this.queue.shift();
      this.tokensMs -= cost;
      this.send(head);
    }
    if (!this.queue.length) for (const resolve of this.idle.splice(0)) resolve();
  }
}

/** Audio frames of `frameMs` (whole samples), silence-padded to `minMs` when flushed short. */
export class Framer {
  private readonly frames: FrameAggregator;

  constructor(
    readonly format: AudioFormat,
    frameMs: number,
    private readonly minMs: number,
  ) {
    this.frames = new FrameAggregator(format, frameMs);
  }

  push(bytes: Uint8Array): Uint8Array[] {
    return this.frames.push(bytes);
  }

  silence(ms: number): Uint8Array[] {
    return this.frames.push(silence(this.format, ms));
  }

  rest(): Uint8Array | undefined {
    return this.frames.flush({ padToMs: this.minMs });
  }
}
