/**
 * Receive jitter buffer for G.711 (one byte per sample at 8 kHz). Packets are placed by extended
 * RTP timestamp, so reordering, duplicates and any inbound ptime (10–60 ms) fall out of the same
 * arithmetic; the output is always one 20 ms frame, with codec silence where samples are missing.
 */
export const FRAME_SAMPLES = 160;

export interface JitterOptions {
  /** Codec silence byte: 0xFF for μ-law, 0xD5 for A-law. */
  silence: number;
  targetMs?: number;
  minMs?: number;
  maxMs?: number;
}

export interface JitterFrame {
  frame: Uint8Array;
  /** True when any sample was concealed (silence PLC) after playout started. */
  concealed: boolean;
}

export interface JitterStats {
  late: number;
  duplicates: number;
  concealedFrames: number;
  underruns: number;
  skippedMs: number;
}

const samplesOf = (ms: number) => Math.round(ms * 8);

export class JitterBuffer {
  private packets: { ts: number; payload: Uint8Array }[] = [];
  private readTs?: number;
  private playing = false;
  private target: number;
  private readonly min: number;
  private readonly max: number;
  readonly stats: JitterStats = {
    late: 0,
    duplicates: 0,
    concealedFrames: 0,
    underruns: 0,
    skippedMs: 0,
  };

  constructor(private readonly options: JitterOptions) {
    this.min = samplesOf(options.minMs ?? 40);
    this.max = samplesOf(options.maxMs ?? 200);
    this.target = samplesOf(options.targetMs ?? 60);
  }

  /** Adapts the target delay to the measured interarrival jitter, within [min, max]. */
  adapt(jitterMs: number): void {
    this.target = Math.min(this.max, Math.max(this.min, samplesOf(2 * jitterMs + 40)));
  }

  get targetMs(): number {
    return this.target / 8;
  }

  /** Buffered audio ahead of the read position, in samples. */
  get depth(): number {
    const end = this.packets.at(-1);
    if (!end || this.readTs === undefined) return 0;
    return Math.max(0, end.ts + end.payload.length - this.readTs);
  }

  push(ts: number, payload: Uint8Array): 'ok' | 'late' | 'duplicate' {
    if (!payload.length) return 'ok';
    if (this.readTs === undefined) this.readTs = ts;
    if (ts + payload.length <= this.readTs) {
      this.stats.late += 1;
      return 'late';
    }
    let index = this.packets.length;
    while (index > 0 && this.packets[index - 1]!.ts > ts) index -= 1;
    if (this.packets[index - 1]?.ts === ts) {
      this.stats.duplicates += 1;
      return 'duplicate';
    }
    this.packets.splice(index, 0, { ts, payload: Uint8Array.from(payload) });
    // Too far behind the newest audio (a faster far-end clock, or a burst): jump to the target.
    if (this.depth > this.max) {
      const skipTo = this.packets.at(-1)!.ts + this.packets.at(-1)!.payload.length - this.target;
      this.stats.skippedMs += (skipTo - this.readTs) / 8;
      this.readTs = skipTo;
      this.packets = this.packets.filter((p) => p.ts + p.payload.length > skipTo);
    }
    return 'ok';
  }

  /** One 20 ms frame. Before playout starts (prefill) it is silence and not counted as PLC. */
  pop(): JitterFrame {
    const frame = new Uint8Array(FRAME_SAMPLES).fill(this.options.silence);
    if (this.readTs === undefined) return { frame, concealed: false };
    if (!this.playing) {
      if (this.depth < this.target) return { frame, concealed: false };
      this.playing = true;
    }
    const start = this.readTs;
    const end = start + FRAME_SAMPLES;
    let filled = 0;
    for (const packet of this.packets) {
      if (packet.ts >= end) break;
      const from = Math.max(start, packet.ts);
      const to = Math.min(end, packet.ts + packet.payload.length);
      if (to <= from) continue;
      frame.set(packet.payload.subarray(from - packet.ts, to - packet.ts), from - start);
      filled += to - from;
    }
    this.packets = this.packets.filter((p) => p.ts + p.payload.length > end);
    this.readTs = end;
    const concealed = filled < FRAME_SAMPLES;
    if (concealed) this.stats.concealedFrames += 1;
    if (filled === 0) {
      // Starved: re-prefill from the next packet instead of drifting ahead of the far end.
      this.stats.underruns += 1;
      if (!this.packets.length) {
        this.playing = false;
        this.readTs = undefined;
      }
    }
    return { frame, concealed };
  }

  reset(): void {
    this.packets = [];
    this.readTs = undefined;
    this.playing = false;
  }
}
