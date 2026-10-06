import type { Pool } from 'pg';
import speechClips from '../../migrations/001_speech_clips.sql?raw';

/** Applied in order; a migration's version is its position, starting at 1. */
const MIGRATIONS: readonly string[] = [speechClips];

/** Idempotent and safe to race: the API and every worker run it on startup. */
export async function runSpeechClipMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ovo-speech-clip-migrations'))");
    await client.query(
      'CREATE TABLE IF NOT EXISTS ovo_speech_schema_migrations ' +
        '(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const [index, sql] of MIGRATIONS.entries()) {
      const claimed = await client.query(
        'INSERT INTO ovo_speech_schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING',
        [index + 1],
      );
      if (claimed.rowCount) await client.query(sql);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
