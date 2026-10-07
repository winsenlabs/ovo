import {
  composeReleaseTextFilters,
  normalizeSpeechInventory,
  staticSpeechInventory,
} from '@winsendotai/ovo-plugin-speech-cache';
import {
  openSpeechClipDatabase,
  type PrerenderJob,
  type PrerenderState,
  type SpeechClipDatabase,
} from '@winsendotai/ovo-plugin-speech-cache/postgres';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import type { PluginDefinition } from '@winsendotai/ovo-runtime';

/**
 * `GET /v1/agents/:agentId/releases/:releaseId/speech-clips`. Progress is `state`, the field name
 * every OVO status response uses (the price catalog's import state too); there is no `status`
 * field. Pre-render is finished when `state` is `done` (or `failed`/`skipped`) and `pending` is 0.
 */
export interface SpeechClipStatus {
  /**
   * `queued` | `running` | `done` | `failed` | `skipped`: the release's pre-render job.
   * `disabled`: the release does not opt in to the speech cache. `unavailable`: this installation
   * has no durable clip store (SQLite). `not-requested`: published before pre-rendering existed.
   */
  state: 'disabled' | 'unavailable' | 'not-requested' | PrerenderState;
  /** Fixed lines in the release's inventory, on the speaker's post-filter text. */
  total: number;
  /** Fixed lines whose clip is stored. */
  ready: number;
  /** Fixed lines whose render failed after retries. */
  failed: number;
  /** `total - ready - failed`: lines not rendered yet (all of them while `unavailable`). */
  pending: number;
  /** Templated lines: rendered per call, never pre-rendered or stored. */
  perCall: number;
  /** Identifies the inventory rendered; changes when any fixed line's text changes. */
  inventorySha256: string | null;
  /** The worker's note on a failed or skipped job. */
  detail: string | null;
  requestedAt: string | null;
  finishedAt: string | null;
}

/** Every field the speech-clips response carries, in documentation order. */
export const SPEECH_CLIP_STATUS_FIELDS = [
  'state',
  'total',
  'ready',
  'failed',
  'pending',
  'perCall',
  'inventorySha256',
  'detail',
  'requestedAt',
  'finishedAt',
] as const satisfies readonly (keyof SpeechClipStatus)[];

type Release = Pick<ReleaseRecord, 'id' | 'workspaceId' | 'agentId' | 'config' | 'selections'>;

/**
 * Publish-side half of pre-rendering (TTS-9): counts a release's fixed lines on the speaker's
 * post-filter text, queues the release for a worker to render, and reports progress. The API never
 * synthesizes speech itself.
 */
export class ApiSpeechPrerender {
  private database?: Promise<SpeechClipDatabase>;

  constructor(
    private readonly connectionString: string | undefined,
    private readonly catalog: readonly PluginDefinition[],
    private readonly defaults: { textFilters?: readonly string[] } = {},
  ) {}

  get available(): boolean {
    return Boolean(this.connectionString);
  }

  async inventory(release: Release): Promise<{ total: number; perCall: number; sha256: string }> {
    const filters = await composeReleaseTextFilters(release, this.catalog, this.defaults);
    try {
      const inventory = normalizeSpeechInventory(
        staticSpeechInventory(release),
        filters.filters,
        release.config.language,
      );
      return {
        total: inventory.texts.length,
        perCall: inventory.perCall,
        sha256: inventory.sha256,
      };
    } finally {
      await filters.close();
    }
  }

  /** Queues the release; a release that does not opt in to the speech cache is never queued. */
  async enqueue(release: Release): Promise<PrerenderJob | undefined> {
    if (!release.config.speechCache?.enabled || !this.available) return undefined;
    const inventory = await this.inventory(release);
    return (await this.open()).queue.enqueue({
      workspaceId: release.workspaceId,
      releaseId: release.id,
      agentId: release.agentId,
      reason: 'publish',
      total: inventory.total,
      perCall: inventory.perCall,
      inventorySha256: inventory.sha256,
    });
  }

  async status(release: Release): Promise<SpeechClipStatus> {
    const empty = {
      ready: 0,
      failed: 0,
      inventorySha256: null,
      detail: null,
      requestedAt: null,
      finishedAt: null,
    };
    if (!release.config.speechCache?.enabled) {
      const inventory = await this.inventory(release);
      return {
        state: 'disabled',
        total: inventory.total,
        perCall: inventory.perCall,
        pending: 0,
        ...empty,
      };
    }
    const inventory = await this.inventory(release);
    if (!this.available)
      return {
        state: 'unavailable',
        total: inventory.total,
        perCall: inventory.perCall,
        pending: inventory.total,
        ...empty,
        inventorySha256: inventory.sha256,
      };
    const database = await this.open();
    const [job, counts] = await Promise.all([
      database.queue.get(release.workspaceId, release.id),
      database.clips.releaseCounts(release.workspaceId, release.id),
    ]);
    const total = job?.total || inventory.total;
    return {
      state: job?.state ?? 'not-requested',
      total,
      ready: counts.ready,
      failed: counts.failed,
      pending: Math.max(0, total - counts.ready - counts.failed),
      perCall: inventory.perCall,
      inventorySha256: job?.inventorySha256 ?? inventory.sha256,
      detail: job?.detail ?? null,
      requestedAt: job?.requestedAt ?? null,
      finishedAt: job?.finishedAt ?? null,
    };
  }

  async close(): Promise<void> {
    const database = this.database;
    this.database = undefined;
    if (database) await (await database).close();
  }

  private open(): Promise<SpeechClipDatabase> {
    this.database ??= openSpeechClipDatabase({
      connectionString: this.connectionString!,
      maxConnections: 2,
    });
    this.database.catch(() => (this.database = undefined));
    return this.database;
  }
}

/** PostgreSQL installations get the durable queue; SQLite ones report `unavailable`. */
export function createApiSpeechPrerender(
  options: { controlDatabaseUrl?: string; storageAdapter?: string },
  catalog: readonly PluginDefinition[],
  defaults?: { textFilters?: readonly string[] },
): ApiSpeechPrerender {
  return new ApiSpeechPrerender(
    options.storageAdapter === 'postgres' ? options.controlDatabaseUrl : undefined,
    catalog,
    defaults,
  );
}
