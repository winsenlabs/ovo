import { createHash } from 'node:crypto';

/** Hold clips kept in one worker's memory, least recently played evicted first (design 7.6). */
export const HOLD_CLIP_CACHE_BYTES = 32 * 1024 * 1024;

/** `operations.routing.audio.content`: a clip's 8 kHz mu-law bytes by id and pinned digest. */
export type HoldClipLoader = (id: string, sha256: string) => Promise<Uint8Array | undefined>;

/**
 * The operator-uploaded hold clips (music, custom recordings) of every routing point this worker
 * serves, read from the operations database by the digest the routing release pinned and kept in a
 * bounded LRU, so a hold that loops a clip, or the next call on the same point, reads it once. A
 * clip whose bytes do not hash to the pinned digest is treated as missing; concurrent reads of one
 * clip share one load.
 */
export class HoldClipCache {
  private readonly entries = new Map<string, Uint8Array>();
  private readonly loading = new Map<string, Promise<Uint8Array | undefined>>();
  private bytes = 0;

  constructor(
    private readonly load: HoldClipLoader,
    readonly maxBytes = HOLD_CLIP_CACHE_BYTES,
  ) {}

  get size(): { clips: number; bytes: number } {
    return { clips: this.entries.size, bytes: this.bytes };
  }

  async get(id: string, sha256: string | undefined): Promise<Uint8Array | undefined> {
    if (!sha256) return undefined;
    const key = `${id}:${sha256}`;
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    let pending = this.loading.get(key);
    if (!pending) {
      pending = this.fetch(id, sha256, key).finally(() => this.loading.delete(key));
      this.loading.set(key, pending);
    }
    return pending;
  }

  private async fetch(id: string, sha256: string, key: string): Promise<Uint8Array | undefined> {
    const audio = await this.load(id, sha256);
    if (!audio?.byteLength) return undefined;
    if (createHash('sha256').update(audio).digest('hex') !== sha256) return undefined;
    if (audio.byteLength <= this.maxBytes) {
      this.entries.set(key, audio);
      this.bytes += audio.byteLength;
      for (const [victim, held] of this.entries) {
        if (this.bytes <= this.maxBytes) break;
        this.entries.delete(victim);
        this.bytes -= held.byteLength;
      }
    }
    return audio;
  }
}
