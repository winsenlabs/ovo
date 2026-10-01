import type { QueryResultRow } from 'pg';
import type { RecordingSegment, RecordingTimelineEvent } from '../types.ts';

export function segmentRow(row: QueryResultRow): RecordingSegment {
  return {
    artifactId: String(row.artifact_id),
    track: row.track,
    sequence: Number(row.sequence),
    state: row.state,
    objectKey: row.object_key ?? undefined,
    sha256: row.sha256 ?? undefined,
    bytes: Number(row.bytes),
    startMs: Number(row.start_ms),
    endMs: Number(row.end_ms),
    timestampEvidence: row.timestamp_evidence,
    error: row.error ?? undefined,
  };
}
export function timelineRow(row: QueryResultRow): RecordingTimelineEvent {
  return {
    artifactId: String(row.artifact_id),
    sequence: Number(row.sequence),
    atMs: Number(row.at_ms),
    type: row.type,
    evidence: row.evidence,
    reference: String(row.reference),
    phase: row.phase ?? undefined,
  };
}
export function cap(value: number) {
  return Math.min(100, Math.max(1, value));
}
