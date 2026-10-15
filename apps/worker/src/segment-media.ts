import type { VoiceMediaTransport } from '@winsendotai/ovo-contracts';

/** Caller audio held between one segment's engine and the next (routing design 8.3). */
export const SEGMENT_GAP_MS = 2_000;
/** Keypresses held over the same gap; a caller does not press more than this in two seconds. */
const MAX_GAP_DIGITS = 32;

type GapEvent = { kind: 'audio'; bytes: Uint8Array; at: number } | { kind: 'dtmf'; digit: string };
type Listener<Args extends unknown[]> = (...args: Args) => void;

/**
 * What one segment's engine sees of the call's media link (routing design 7.4). The link outlives
 * every segment, so the lease:
 *
 * - holds a single subscription per kind on the link and drops them all on `release`, with every
 *   listener the engine added, so a disposed engine never hears the next segment's caller;
 * - keeps the link open when its engine closes media while the call is handing off
 *   (`interceptClose`), and closes the link otherwise;
 * - starts `held` for a prepared, unstarted engine (it hears and sends nothing), then from the
 *   previous engine's end (`buffer`) holds at most two seconds of caller audio and keypresses
 *   while its own engine starts, and replays them, in order, before any live input (`open`).
 *   Older audio past the bound is dropped and counted. A starting engine already speaks, and
 *   hears the carrier's playback marks for what it sends.
 */
export class SegmentMediaLease implements VoiceMediaTransport {
  private state: 'held' | 'buffering' | 'live' | 'released';
  private readonly links: (() => void)[] = [];
  private readonly audio = new Set<Listener<[Uint8Array, number]>>();
  private readonly marks = new Set<Listener<[string]>>();
  private readonly dtmf = new Set<Listener<[string]>>();
  private readonly closes = new Set<Listener<[string]>>();
  private gap: GapEvent[] = [];
  private gapBytes = 0;
  private droppedBytes = 0;
  private droppedDigits = 0;
  private readonly bytesPerSecond: number;
  private readonly maxGapBytes: number;
  private readonly interceptClose: (reason: string) => boolean;

  constructor(
    private readonly media: VoiceMediaTransport,
    options: {
      format: { sampleRate: number; encoding: string };
      /** False for a prepared segment: it hears nothing until `buffer` or `open`. */
      live?: boolean;
      /** True keeps the link open: the call is handing off to the next segment. */
      interceptClose?: (reason: string) => boolean;
      maxGapMs?: number;
    },
  ) {
    this.state = options.live === false ? 'held' : 'live';
    this.interceptClose = options.interceptClose ?? (() => false);
    this.bytesPerSecond =
      options.format.sampleRate * (options.format.encoding === 'pcm_s16le' ? 2 : 1);
    this.maxGapBytes = (this.bytesPerSecond * (options.maxGapMs ?? SEGMENT_GAP_MS)) / 1000;
    this.links.push(
      media.onAudio((bytes, at) => this.input({ kind: 'audio', bytes, at })),
      media.onDtmf((digit) => this.input({ kind: 'dtmf', digit })),
      media.onMark((name) => {
        if (this.speaks) for (const listener of [...this.marks]) listener(name);
      }),
      media.onClose((reason) => {
        if (this.state !== 'released') for (const listener of [...this.closes]) listener(reason);
      }),
    );
  }

  get sessionId(): string {
    return this.media.sessionId;
  }
  get bufferedBytes(): number {
    return this.media.bufferedBytes;
  }
  get released(): boolean {
    return this.state === 'released';
  }
  private get speaks(): boolean {
    return this.state === 'buffering' || this.state === 'live';
  }
  /** Audio dropped from the gap buffer, in milliseconds, and keypresses dropped from it. */
  get gapDropped(): { ms: number; digits: number } {
    return {
      ms: Math.round((this.droppedBytes * 1000) / this.bytesPerSecond),
      digits: this.droppedDigits,
    };
  }

  /** Starts holding caller input for this segment: the previous engine has stopped hearing it. */
  buffer(): void {
    if (this.state === 'held') this.state = 'buffering';
  }

  /** Replays the held caller input to this segment's engine, then passes input straight on. */
  open(): void {
    if (this.state === 'released' || this.state === 'live') return;
    const held = this.gap;
    this.gap = [];
    this.gapBytes = 0;
    this.state = 'live';
    for (const event of held) this.deliver(event);
  }

  /** Drops every subscription on the link and every listener the engine added. Idempotent. */
  release(): void {
    if (this.state === 'released') return;
    this.state = 'released';
    for (const unsubscribe of this.links.splice(0)) unsubscribe();
    for (const listeners of [this.audio, this.marks, this.dtmf, this.closes]) listeners.clear();
    this.gap = [];
    this.gapBytes = 0;
  }

  sendAudio(audio: Uint8Array, signal?: AbortSignal): Promise<void> {
    return this.output('sendAudio', () => this.media.sendAudio(audio, signal));
  }
  sendMark(name: string, signal?: AbortSignal): Promise<void> {
    return this.output('sendMark', () => this.media.sendMark(name, signal));
  }
  /** A segment that is not speaking has nothing playing to clear. */
  async clear(signal?: AbortSignal): Promise<void> {
    if (this.speaks) await this.media.clear(signal);
  }
  async close(reason: string): Promise<void> {
    if (this.state === 'released' || this.interceptClose(reason)) return;
    await this.media.close(reason);
  }

  onAudio(listener: Listener<[Uint8Array, number]>): () => void {
    return this.add(this.audio, listener);
  }
  onMark(listener: Listener<[string]>): () => void {
    return this.add(this.marks, listener);
  }
  onDtmf(listener: Listener<[string]>): () => void {
    return this.add(this.dtmf, listener);
  }
  onClose(listener: Listener<[string]>): () => void {
    return this.add(this.closes, listener);
  }

  private add<Args extends unknown[]>(
    listeners: Set<Listener<Args>>,
    listener: Listener<Args>,
  ): () => void {
    if (this.state === 'released') return () => undefined;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  private async output(action: string, send: () => Promise<void>): Promise<void> {
    if (!this.speaks) throw new Error(`segment media lease is ${this.state}: ${action}`);
    await send();
  }

  private input(event: GapEvent): void {
    if (this.state === 'live') return this.deliver(event);
    if (this.state !== 'buffering') return;
    this.gap.push(event);
    if (event.kind === 'audio') this.gapBytes += event.bytes.length;
    else if (this.gap.filter((item) => item.kind === 'dtmf').length > MAX_GAP_DIGITS) {
      this.gap.splice(
        this.gap.findIndex((item) => item.kind === 'dtmf'),
        1,
      );
      this.droppedDigits += 1;
    }
    while (this.gapBytes > this.maxGapBytes) {
      const oldest = this.gap.findIndex((item) => item.kind === 'audio');
      const [dropped] = this.gap.splice(oldest, 1) as [Extract<GapEvent, { kind: 'audio' }>];
      this.gapBytes -= dropped.bytes.length;
      this.droppedBytes += dropped.bytes.length;
    }
  }

  private deliver(event: GapEvent): void {
    if (event.kind === 'audio')
      for (const listener of [...this.audio]) listener(event.bytes, event.at);
    else for (const listener of [...this.dtmf]) listener(event.digit);
  }
}
