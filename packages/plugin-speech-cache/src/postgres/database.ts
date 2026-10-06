import pg from 'pg';
import { PostgresSpeechClipStore, type SpeechClipLimits } from './clip-store.ts';
import { runSpeechClipMigrations } from './migrations.ts';
import { PostgresSpeechPrerenderQueue } from './prerender-queue.ts';

export interface SpeechClipDatabase {
  clips: PostgresSpeechClipStore;
  queue: PostgresSpeechPrerenderQueue;
  close(): Promise<void>;
}

/**
 * Every clip query fails fast rather than waiting on Postgres forever (pg's defaults): a caller on
 * the live path has already moved on to live synthesis by then, and nothing should pile up behind.
 */
export const SPEECH_CLIP_POOL_TIMEOUTS = Object.freeze({
  connectionTimeoutMillis: 2_000,
  statement_timeout: 10_000,
});

/**
 * Opens two small pools: one for clip reads, writes and the queue, and one that only holds the
 * per-line render locks. Applies the speech clip migrations and returns both repositories.
 */
export async function openSpeechClipDatabase(
  connection: { connectionString: string; maxConnections?: number; lockConnections?: number },
  limits: SpeechClipLimits = {},
): Promise<SpeechClipDatabase> {
  const pool = new pg.Pool({
    connectionString: connection.connectionString,
    max: connection.maxConnections ?? 4,
    ...SPEECH_CLIP_POOL_TIMEOUTS,
  });
  const lockPool = new pg.Pool({
    connectionString: connection.connectionString,
    max: connection.lockConnections ?? 2,
    ...SPEECH_CLIP_POOL_TIMEOUTS,
  });
  const close = async () => {
    await Promise.all([pool.end(), lockPool.end()]);
  };
  try {
    await runSpeechClipMigrations(pool);
  } catch (error) {
    await close();
    throw error;
  }
  return {
    clips: new PostgresSpeechClipStore(pool, limits, lockPool),
    queue: new PostgresSpeechPrerenderQueue(pool),
    close,
  };
}
