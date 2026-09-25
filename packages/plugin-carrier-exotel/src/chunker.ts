const MIN = 3200;
const MAX = 102400;

/** Carries partial PCM samples and only emits Exotel-compliant outbound chunks. */
export class ExotelChunker {
  private pending = new Uint8Array(0);

  push(payload: Uint8Array): Uint8Array[] {
    if (!payload.byteLength) return [];
    const combined = new Uint8Array(this.pending.byteLength + payload.byteLength);
    combined.set(this.pending);
    combined.set(payload, this.pending.byteLength);
    const chunks: Uint8Array[] = [];
    let offset = 0;
    while (combined.byteLength - offset >= MIN) {
      const available = combined.byteLength - offset;
      const length = Math.min(MAX, Math.floor(available / 320) * 320);
      chunks.push(combined.slice(offset, offset + length));
      offset += length;
    }
    this.pending = combined.slice(offset);
    return chunks;
  }

  flush(): Uint8Array[] {
    if (!this.pending.byteLength) return [];
    const length = Math.max(MIN, Math.ceil(this.pending.byteLength / 320) * 320);
    const padded = new Uint8Array(length);
    padded.set(this.pending);
    this.pending = new Uint8Array(0);
    return [padded];
  }

  clear(): void {
    this.pending = new Uint8Array(0);
  }

  get remainderBytes(): number {
    return this.pending.byteLength;
  }
}
