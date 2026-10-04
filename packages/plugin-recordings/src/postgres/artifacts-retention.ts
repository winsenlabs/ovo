import type { Pool } from 'pg';
import type { RetentionCursor, RetentionPage } from '../types.ts';
import { cap } from './artifacts-rows.ts';
import { recording } from './rows.ts';

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
