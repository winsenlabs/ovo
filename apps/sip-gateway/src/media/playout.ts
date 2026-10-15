/**
 * Downstream playout (§4.5): μ-law from the gateway queued as 160-byte frames with markers in
 * between. The pacer pops one frame per 20 ms; a marker is reported once every byte queued before
 * it has been sent, which is what makes `carrier-played` evidence honest.
 */
export const FRAME_BYTES = 160;
/** 30 s of 8 kHz G.711. */
export const MAX_QUEUED_BYTES = 30 * 8000;
const MULAW_SILENCE = 0xff;

type Entry = { kind: 'audio'; bytes: Uint8Array; offset: number } | { kind: 'mark'; name: string };

export interface PlayoutTick {
  /** The frame to send, or undefined when nothing is queued (the caller sends silence). */
  frame?: Uint8Array;
  /** Marks whose audio has now been sent, in order. */
  marks: string[];
}

export class PlayoutQueue {
  private entries: Entry[] = [];
  private bytes = 0;

  get queuedBytes(): number {
    return this.bytes;
  }

  get queuedMs(): number {
    return this.bytes / 8;
  }

  get empty(): boolean {
    return this.entries.length === 0;
  }

  /** False when the audio would exceed the 30 s cap (the caller ends the call). */
  pushAudio(bytes: Uint8Array): boolean {
    if (!bytes.length) return true;
    if (this.bytes + bytes.length > MAX_QUEUED_BYTES) return false;
    this.entries.push({ kind: 'audio', bytes, offset: 0 });
    this.bytes += bytes.length;
    return true;
  }

  pushMark(name: string): void {
    this.entries.push({ kind: 'mark', name });
  }

  /**
   * Fills one frame. A marker met mid-frame ends the frame early (padded with silence), so the
   * mark fires right after the audio before it, never after audio queued behind it.
   */
  pop(): PlayoutTick {
    const marks = this.leadingMarks();
    if (this.entries[0]?.kind !== 'audio') return { marks };
    const frame = new Uint8Array(FRAME_BYTES).fill(MULAW_SILENCE);
    let filled = 0;
    while (filled < FRAME_BYTES && this.entries[0]?.kind === 'audio') {
      const entry = this.entries[0];
      const take = Math.min(FRAME_BYTES - filled, entry.bytes.length - entry.offset);
      frame.set(entry.bytes.subarray(entry.offset, entry.offset + take), filled);
      filled += take;
      entry.offset += take;
      this.bytes -= take;
      if (entry.offset >= entry.bytes.length) this.entries.shift();
    }
    return { frame, marks: [...marks, ...this.leadingMarks()] };
  }

  private leadingMarks(): string[] {
    const marks: string[] = [];
    for (let entry = this.entries[0]; entry?.kind === 'mark'; entry = this.entries[0]) {
      marks.push(entry.name);
      this.entries.shift();
    }
    return marks;
  }

  /** `clear`: drop queued audio and return every pending mark, in order (clearFlushesMarkers). */
  clear(): string[] {
    const marks = this.entries.flatMap((entry) => (entry.kind === 'mark' ? [entry.name] : []));
    this.entries = [];
    this.bytes = 0;
    return marks;
  }
}
