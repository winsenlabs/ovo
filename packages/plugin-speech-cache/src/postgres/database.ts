import pg from 'pg';
import { PostgresSpeechClipStore, type SpeechClipLimits } from './clip-store.ts';
import { runSpeechClipMigrations } from './migrations.ts';
import { PostgresSpeechPrerenderQueue } from './prerender-queue.ts';

export interface SpeechClipDatabase {
  clips: PostgresSpeechClipStore;
  queue: PostgresSpeechPrerenderQueue;
  close(): Promise<void>;
}

/** Opens a small pool, applies the speech clip migrations, and returns both repositories. */
export async function openSpeechClipDatabase(
  connection: { connectionString: string; maxConnections?: number },
  limits: SpeechClipLimits = {},
): Promise<SpeechClipDatabase> {
  const pool = new pg.Pool({
    connectionString: connection.connectionString,
    max: connection.maxConnections ?? 6,
  });
  try {
    await runSpeechClipMigrations(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }
  return {
    clips: new PostgresSpeechClipStore(pool, limits),
    queue: new PostgresSpeechPrerenderQueue(pool),
    close: () => pool.end(),
  };
}
