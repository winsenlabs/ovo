import type { Pool } from 'pg';

export interface SpeechClipLimits {
  /** One clip; matches the live cache's per-entry ceiling. */
  maxClipBytes?: number;
  /** Everything one workspace may keep durably. */
  maxWorkspaceBytes?: number;
}

export interface StoredSpeechClip {
  workspaceId: string;
  key: string;
  codec: string;
  sampleRate: number;
  audio: Uint8Array;
}

export type SpeechClipPutResult = 'stored' | 'exists' | 'too-large' | 'over-budget';

export interface SpeechClipRef {
  key: string;
  status: 'ready' | 'failed';
  error?: string;
}

const KEY = /^[0-9a-f]{64}$/;

/**
 * Durable tier of the speech cache (TTS-8). It stores audio only, never text, and only for keys a
 * caller has proven are fixed release lines; keeping variable or caller-specific audio out is the
 * caller's contract (the worker's `WorkerSpeechClipCache.persist`) and is asserted by its tests.
 */
export class PostgresSpeechClipStore {
  readonly maxClipBytes: number;
  readonly maxWorkspaceBytes: number;

  /**
   * `lockPool` holds a client for each whole render under `withRenderLock`; keeping those apart
   * from `pool` means renders in flight can never starve a live call's clip read.
   */
  constructor(
    private readonly pool: Pool,
    limits: SpeechClipLimits = {},
    private readonly lockPool: Pool = pool,
  ) {
    this.maxClipBytes = limits.maxClipBytes ?? 2 * 1024 * 1024;
    this.maxWorkspaceBytes = limits.maxWorkspaceBytes ?? 512 * 1024 * 1024;
    for (const [name, value] of Object.entries({
      maxClipBytes: this.maxClipBytes,
      maxWorkspaceBytes: this.maxWorkspaceBytes,
    }))
      if (!Number.isSafeInteger(value) || value < 1)
        throw new TypeError(`${name} must be a positive integer`);
  }

  async get(workspaceId: string, key: string): Promise<Uint8Array | undefined> {
    return (await this.getMany(workspaceId, [key])).get(key);
  }

  /** Reads clips and marks them used (at most once a day, so hot reads stay read-only). */
  async getMany(workspaceId: string, keys: readonly string[]): Promise<Map<string, Uint8Array>> {
    const wanted = [...new Set(keys)].filter((key) => KEY.test(key));
    const found = new Map<string, Uint8Array>();
    if (!wanted.length) return found;
    const result = await this.pool.query<{ clip_key: string; audio: Buffer; stale: boolean }>(
      `SELECT clip_key, audio, last_used_at < now() - interval '1 day' AS stale
         FROM ovo_speech_clips WHERE workspace_id = $1 AND clip_key = ANY($2::text[])`,
      [workspaceId, wanted],
    );
    for (const row of result.rows) found.set(row.clip_key, new Uint8Array(row.audio));
    const stale = result.rows.filter((row) => row.stale).map((row) => row.clip_key);
    if (stale.length)
      await this.pool.query(
        `UPDATE ovo_speech_clips SET last_used_at = now()
          WHERE workspace_id = $1 AND clip_key = ANY($2::text[])`,
        [workspaceId, stale],
      );
    return found;
  }

  async put(clip: StoredSpeechClip): Promise<SpeechClipPutResult> {
    if (!KEY.test(clip.key)) throw new TypeError('Speech clip key must be a sha256 hex digest');
    if (!clip.audio.byteLength) throw new TypeError('Speech clip audio must not be empty');
    if (clip.audio.byteLength > this.maxClipBytes) return 'too-large';
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `ovo-speech-clips:${clip.workspaceId}`,
      ]);
      const inserted = await client.query(
        `INSERT INTO ovo_speech_clips
           (workspace_id, clip_key, codec, sample_rate, byte_length, audio)
         SELECT $1, $2, $3, $4::integer, $5::integer, $6
          WHERE (SELECT coalesce(sum(byte_length), 0) FROM ovo_speech_clips
                  WHERE workspace_id = $1) + $5::integer <= $7::bigint
         ON CONFLICT (workspace_id, clip_key) DO NOTHING
         RETURNING 1`,
        [
          clip.workspaceId,
          clip.key,
          clip.codec,
          clip.sampleRate,
          clip.audio.byteLength,
          Buffer.from(clip.audio.buffer, clip.audio.byteOffset, clip.audio.byteLength),
          this.maxWorkspaceBytes,
        ],
      );
      let result: SpeechClipPutResult = 'stored';
      if (!inserted.rowCount) {
        const existing = await client.query(
          'SELECT 1 FROM ovo_speech_clips WHERE workspace_id = $1 AND clip_key = $2',
          [clip.workspaceId, clip.key],
        );
        result = existing.rowCount ? 'exists' : 'over-budget';
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Runs one render while holding a per-key advisory lock, so two workers warming the same release
   * do not pay for the same line twice. `locked: false` means another worker is rendering it.
   */
  async withRenderLock<T>(
    workspaceId: string,
    key: string,
    run: () => Promise<T>,
  ): Promise<{ locked: true; value: T } | { locked: false }> {
    const lock = `ovo-speech-render:${workspaceId}:${key}`;
    const client = await this.lockPool.connect();
    try {
      const acquired = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [lock],
      );
      if (!acquired.rows[0]?.locked) return { locked: false };
      try {
        return { locked: true, value: await run() };
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lock]);
      }
    } finally {
      client.release();
    }
  }

  /** Records which clips a release needs; refreshing a ref keeps its clip out of GC. */
  async markRefs(
    workspaceId: string,
    releaseId: string,
    refs: readonly SpeechClipRef[],
  ): Promise<void> {
    if (!refs.length) return;
    await this.pool.query(
      `INSERT INTO ovo_speech_clip_refs (workspace_id, release_id, clip_key, status, error)
       SELECT $1, $2, ref.key, ref.status, ref.error
         FROM jsonb_to_recordset($3::jsonb) AS ref(key text, status text, error text)
       ON CONFLICT (workspace_id, release_id, clip_key)
       DO UPDATE SET status = excluded.status, error = excluded.error, updated_at = now()`,
      [
        workspaceId,
        releaseId,
        JSON.stringify(
          refs.map((ref) => ({
            key: ref.key,
            status: ref.status,
            error: ref.error?.slice(0, 500) ?? null,
          })),
        ),
      ],
    );
  }

  async releaseCounts(
    workspaceId: string,
    releaseId: string,
  ): Promise<{ ready: number; failed: number }> {
    const result = await this.pool.query<{ ready: string; failed: string }>(
      `SELECT count(*) FILTER (WHERE status = 'ready') AS ready,
              count(*) FILTER (WHERE status = 'failed') AS failed
         FROM ovo_speech_clip_refs WHERE workspace_id = $1 AND release_id = $2`,
      [workspaceId, releaseId],
    );
    return {
      ready: Number(result.rows[0]?.ready ?? 0),
      failed: Number(result.rows[0]?.failed ?? 0),
    };
  }

  /** Drops refs nobody refreshed for `days`, then clips that are unused and unreferenced. */
  async collectGarbage(days = 30): Promise<{ refs: number; clips: number }> {
    if (!Number.isSafeInteger(days) || days < 1) throw new TypeError('days must be positive');
    const refs = await this.pool.query(
      `DELETE FROM ovo_speech_clip_refs WHERE updated_at < now() - make_interval(days => $1)`,
      [days],
    );
    const clips = await this.pool.query(
      `DELETE FROM ovo_speech_clips clip
        WHERE clip.last_used_at < now() - make_interval(days => $1)
          AND NOT EXISTS (SELECT 1 FROM ovo_speech_clip_refs ref
                           WHERE ref.workspace_id = clip.workspace_id
                             AND ref.clip_key = clip.clip_key)`,
      [days],
    );
    return { refs: refs.rowCount ?? 0, clips: clips.rowCount ?? 0 };
  }
}
