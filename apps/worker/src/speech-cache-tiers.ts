import {
  BoundedByteCache,
  PinnedByteStore,
  type ByteCacheLimits,
} from '@winsendotai/ovo-plugin-cache';
import { createLogger, errorFields } from '@winsendotai/ovo-plugin-kit';
import type {
  SpeechClipPutResult,
  SpeechClipRef,
  StoredSpeechClip,
} from '@winsendotai/ovo-plugin-speech-cache/postgres';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';

/** The durable tier's surface; `PostgresSpeechClipStore` satisfies it. */
export interface SpeechClipStore {
  readonly maxClipBytes: number;
  get(workspaceId: string, key: string): Promise<Uint8Array | undefined>;
  getMany(workspaceId: string, keys: readonly string[]): Promise<Map<string, Uint8Array>>;
  put(clip: StoredSpeechClip): Promise<SpeechClipPutResult>;
  markRefs(workspaceId: string, releaseId: string, refs: readonly SpeechClipRef[]): Promise<void>;
  withRenderLock?<T>(
    workspaceId: string,
    key: string,
    run: () => Promise<T>,
  ): Promise<{ locked: true; value: T } | { locked: false }>;
}

export type SpeechClipTier = 'pinned' | 'l1';
type ReleaseRef = Pick<ReleaseRecord, 'id' | 'agentId' | 'workspaceId'>;

/**
 * A release that is no longer routed keeps its pins this long after its last session or warm, so
 * calls still running on it (or a just-published release no route points at yet) stay warm.
 */
export const UNROUTED_PIN_GRACE_MS = 30 * 60 * 1000;

const log = createLogger({ service: 'worker', component: 'speech-cache' });

/**
 * Lookup order pinned → L1 → durable → live (TTS-7/TTS-8). It is still the process `ByteCache`
 * (L1 is the base class), so every existing caller keeps working; tier-aware callers use the rest.
 */
export class WorkerSpeechClipCache extends BoundedByteCache {
  readonly pinned: PinnedByteStore;
  readonly maxClipBytes: number;
  private durableStore?: SpeechClipStore;
  /** Release id → when it last had a session or a warm on this worker. */
  private readonly lastActive = new Map<string, number>();
  /** Release ids some route or campaign currently points at; unknown without a durable tier. */
  private routed?: ReadonlySet<string>;
  private readonly sessionListeners = new Set<(release: ReleaseRecord) => void>();
  private readonly lifetime = new AbortController();
  private durableReadFailed = false;

  private readonly now: () => number;

  constructor(
    limits: ByteCacheLimits = {},
    options: { pinnedMaxBytes?: number; maxClipBytes?: number; now?: () => number } = {},
  ) {
    super(limits);
    this.now = options.now ?? Date.now;
    this.pinned = new PinnedByteStore(options.pinnedMaxBytes ?? 256 * 1024 * 1024);
    this.maxClipBytes = options.maxClipBytes ?? 2 * 1024 * 1024;
  }

  get durable(): SpeechClipStore | undefined {
    return this.durableStore;
  }

  /** Aborted when the worker closes: detached renders stop then, never on a caller's barge-in. */
  get signal(): AbortSignal {
    return this.lifetime.signal;
  }

  attachDurable(store: SpeechClipStore): void {
    this.durableStore = store;
  }

  lookup(
    key: string,
    workspaceId: string,
  ): { audio: Uint8Array; tier: SpeechClipTier } | undefined {
    const pinned = this.pinned.get(key, workspaceId);
    if (pinned) return { audio: pinned, tier: 'pinned' };
    const cached = this.get(key, workspaceId);
    return cached ? { audio: cached, tier: 'l1' } : undefined;
  }

  /**
   * A release is in use on this worker. Its pins last as long as it stays routed (TTS-7); two
   * releases of one agent can be live together (an inbound route on the new one, a campaign still
   * on the old one), so activating one never lets go of another's pins.
   */
  activate(release: ReleaseRef): void {
    this.lastActive.set(release.id, this.now());
  }

  /**
   * Pins one release line. Over the byte budget, releases nothing routes to are let go, least
   * recently active first, before the pin is refused; a routed release's pins are never evicted.
   */
  pin(release: ReleaseRef, key: string, audio: Uint8Array): boolean {
    if (!this.lastActive.has(release.id)) this.activate(release);
    if (this.pinned.pin(release.id, key, release.workspaceId, audio)) return true;
    if (this.pinned.has(key, release.workspaceId)) return false;
    while (this.pinned.stats.bytes + audio.byteLength > this.pinned.maxBytes) {
      const victim = this.leastRecentlyActive(release.id);
      if (!victim) return false;
      this.dropRelease(victim);
    }
    return this.pinned.pin(release.id, key, release.workspaceId, audio);
  }

  /**
   * The releases routes and campaigns point at right now. Pins of releases that dropped out are let
   * go once their grace since the last session or warm has passed. Returns the releases let go.
   */
  retainRouted(releaseIds: Iterable<string>): string[] {
    this.routed = new Set(releaseIds);
    const cutoff = this.now() - UNROUTED_PIN_GRACE_MS;
    const dropped = [...this.lastActive]
      .filter(([id, at]) => !this.routed!.has(id) && at < cutoff)
      .map(([id]) => id);
    for (const id of dropped) this.dropRelease(id);
    return dropped;
  }

  private leastRecentlyActive(except: string): string | undefined {
    let victim: string | undefined;
    let oldest = Infinity;
    for (const [id, at] of this.lastActive)
      if (id !== except && !this.routed?.has(id) && at < oldest) {
        victim = id;
        oldest = at;
      }
    return victim;
  }

  private dropRelease(releaseId: string): void {
    this.pinned.release(releaseId);
    this.lastActive.delete(releaseId);
  }

  async fromDurable(key: string, workspaceId: string): Promise<Uint8Array | undefined> {
    if (!this.durableStore) return undefined;
    try {
      const audio = await this.durableStore.get(workspaceId, key);
      this.durableReadFailed = false;
      return audio;
    } catch (error) {
      // A durable outage degrades to live synthesis; it is logged once per outage, not per line.
      if (!this.durableReadFailed) log.warn('speech_clip_durable_read_failed', errorFields(error));
      this.durableReadFailed = true;
      return undefined;
    }
  }

  /** Durable writes are for fixed release lines only; callers prove that before calling. */
  async persist(release: ReleaseRef, clip: Omit<StoredSpeechClip, 'workspaceId'>): Promise<void> {
    const store = this.durableStore;
    if (!store) return;
    try {
      const result = await store.put({ ...clip, workspaceId: release.workspaceId });
      if (result === 'too-large' || result === 'over-budget')
        log.warn('speech_clip_not_persisted', { result, bytes: clip.audio.byteLength });
      await store.markRefs(release.workspaceId, release.id, [
        result === 'stored' || result === 'exists'
          ? { key: clip.key, status: 'ready' }
          : { key: clip.key, status: 'failed', error: result },
      ]);
    } catch (error) {
      log.warn('speech_clip_persist_failed', errorFields(error));
    }
  }

  /** The first call on this worker for a release asks for the rest of its lines to be warmed. */
  onSession(listener: (release: ReleaseRecord) => void): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  sessionStarted(release: ReleaseRecord): void {
    this.activate(release);
    for (const listener of this.sessionListeners) listener(release);
  }

  override invalidateWorkspace(workspaceId: string): number {
    return super.invalidateWorkspace(workspaceId) + this.pinned.invalidateWorkspace(workspaceId);
  }

  override clear(): void {
    super.clear();
    this.pinned.clear();
    this.lastActive.clear();
  }

  close(): void {
    this.lifetime.abort(new DOMException('speech cache closed', 'AbortError'));
    this.clear();
  }
}
