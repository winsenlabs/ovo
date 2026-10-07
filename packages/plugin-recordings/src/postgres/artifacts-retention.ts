import type { Pool } from 'pg';
import { ABANDONED_FAILURE } from '../repository.ts';
import type { RetentionCursor, RetentionPage } from '../types.ts';
import { cap } from './artifacts-rows.ts';
import { recording } from './rows.ts';

/** `RecordingRepository.recoverAbandoned`: one statement, skipping rows another sweeper holds. */
export async function recoverAbandonedArtifacts(
  pool: Pool,
  createdBefore: string,
  at: string,
  limit: number,
): Promise<number> {
  const result = await pool.query(
    `UPDATE ovo_recording_artifacts a SET
       state=CASE WHEN EXISTS(SELECT 1 FROM ovo_recording_segments s
         WHERE s.artifact_id=a.id AND s.state='available') THEN 'partial' ELSE 'failed' END,
       updated_at=$2, failure=$3
     WHERE a.id IN (SELECT b.id FROM ovo_recording_artifacts b
       WHERE b.state IN ('starting','active','paused','finalizing') AND b.created_at<$1
       AND NOT EXISTS(SELECT 1 FROM ovo_recording_tombstones t WHERE t.artifact_id=b.id)
       ORDER BY b.created_at,b.id LIMIT $4 FOR UPDATE SKIP LOCKED)`,
    [createdBefore, at, ABANDONED_FAILURE, cap(limit)],
  );
  return result.rowCount ?? 0;
}

export async function pageExpiredArtifacts(
  pool: Pool,
  now: string,
  cursor: RetentionCursor | undefined,
  limit: number,
): Promise<RetentionPage> {
  const result = await pool.query(
    `SELECT a.* FROM ovo_recording_artifacts a WHERE a.expires_at<=$1 AND a.state!='expired'
     AND NOT EXISTS(SELECT 1 FROM ovo_recording_tombstones t WHERE t.artifact_id=a.id)
     AND ($2::timestamptz IS NULL OR (a.expires_at,a.id)>($2::timestamptz,$3::uuid))
     ORDER BY a.expires_at,a.id LIMIT $4`,
    [now, cursor?.expiresAt ?? null, cursor?.artifactId ?? null, cap(limit)],
  );
  const items = result.rows.map(recording),
    last = items.at(-1);
  return {
    items,
    nextCursor:
      items.length === limit && last
        ? { expiresAt: last.expiresAt, artifactId: last.id }
        : undefined,
  };
}
