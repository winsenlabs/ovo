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

const log = createLogger({ service: 'worker', component: 'speech-cache' });

/**
 * Lookup order pinned → L1 → durable → live (TTS-7/TTS-8). It is still the process `ByteCache`
 * (L1 is the base class), so every existing caller keeps working; tier-aware callers use the rest.
 */
export class WorkerSpeechClipCache extends BoundedByteCache {
  readonly pinned: PinnedByteStore;
  readonly maxClipBytes: number;
  private durableStore?: SpeechClipStore;
  private readonly releaseAgents = new Map<string, string>();
  private readonly sessionListeners = new Set<(release: ReleaseRecord) => void>();
  private readonly lifetime = new AbortController();
  private durableReadFailed = false;

  constructor(
    limits: ByteCacheLimits = {},
    options: { pinnedMaxBytes?: number; maxClipBytes?: number } = {},
  ) {
    super(limits);
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
   * A release becomes the agent's live one: its fixed lines stay pinned for as long as it is, and
   * the release it replaced for the same agent lets go of its pins.
   */
  activate(release: ReleaseRef): void {
    for (const [releaseId, agentId] of this.releaseAgents)
      if (agentId === release.agentId && releaseId !== release.id) {
        this.pinned.release(releaseId);
        this.releaseAgents.delete(releaseId);
      }
    this.releaseAgents.set(release.id, release.agentId);
  }

  pin(release: ReleaseRef, key: string, audio: Uint8Array): boolean {
    if (!this.releaseAgents.has(release.id)) this.activate(release);
    return this.pinned.pin(release.id, key, release.workspaceId, audio);
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
    this.releaseAgents.clear();
  }

  close(): void {
    this.lifetime.abort(new DOMException('speech cache closed', 'AbortError'));
    this.clear();
  }
}
