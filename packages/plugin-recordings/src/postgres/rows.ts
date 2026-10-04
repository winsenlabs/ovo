import type { QueryResultRow } from 'pg';
import type { LiveRecording, RecordingExportJob, RecordingTombstone } from '../types.ts';

export function recording(row: QueryResultRow): LiveRecording {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    callId: String(row.call_id),
    source: 'carrier',
    state: row.state as LiveRecording['state'],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    expiresAt: iso(row.expires_at),
    codec: 'audio/x-mulaw',
    sampleRate: 8000,
    channels: 2,
    segmentBytes: Number(row.segment_bytes),
    failure: optional(row.failure),
  };
}

export function tombstone(row: QueryResultRow): RecordingTombstone {
  return {
    artifactId: String(row.artifact_id),
    workspaceId: String(row.workspace_id),
    callId: String(row.call_id),
    requestedAt: iso(row.requested_at),
    reason: row.reason as RecordingTombstone['reason'],
    cleanupState: row.cleanup_state as RecordingTombstone['cleanupState'],
    attempts: Number(row.attempts),
    lastError: optional(row.last_error),
    completedAt: row.completed_at ? iso(row.completed_at) : undefined,
  };
}

export function exportJob(row: QueryResultRow): RecordingExportJob {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    artifactId: String(row.artifact_id),
    idempotencyKey: String(row.idempotency_key),
    state: row.state as RecordingExportJob['state'],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    attempts: Number(row.attempts),
    leaseOwner: optional(row.lease_owner),
    leaseEpoch: Number(row.lease_epoch),
    leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : undefined,
    outputKey: optional(row.output_key),
    outputSha256: optional(row.output_sha256),
    outputBytes:
      row.output_bytes === null || row.output_bytes === undefined
        ? undefined
        : Number(row.output_bytes),
    error: optional(row.error),
  };
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function optional(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}
