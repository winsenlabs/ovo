import type { CallTelemetryProjection } from './telemetry-types.ts';

export function mapEvent(row: Record<string, any>) {
  return {
    schemaVersion: 1 as const,
    eventId: row.event_id,
    workspaceId: row.workspace_id,
    callId: row.call_id,
    sequence: Number(row.sequence),
    occurredAt: new Date(row.occurred_at).toISOString(),
    ingestedAt: new Date(row.ingested_at).toISOString(),
    source: row.source,
    kind: row.kind,
    agentId: row.agent_id ?? undefined,
    releaseId: row.release_id ?? undefined,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    language: row.language ?? undefined,
    turnId: row.turn_id ?? undefined,
    responseEpoch: row.response_epoch === null ? undefined : Number(row.response_epoch),
    stageId: row.stage_id ?? undefined,
    stage: row.stage ?? undefined,
    operationId: row.operation_id ?? undefined,
    segmentId: row.segment_id ?? undefined,
    durationMs: row.duration_ms === null ? undefined : Number(row.duration_ms),
    outcome: row.outcome ?? undefined,
    evidence: row.evidence ?? undefined,
    payload: row.payload,
  };
}

function iso(value: unknown): string | null {
  return value ? new Date(value as string).toISOString() : null;
}

export function mapProjection(
  call: any,
  stages: any[],
  playback: any[],
  operations: any[],
): CallTelemetryProjection {
  return {
    callId: call.call_id,
    source: call.source,
    lastSequence: Number(call.last_sequence),
    eventCount: Number(call.event_count),
    gapDetected: call.gap_detected,
    status: call.status,
    stages: stages.map((row) => ({
      stageId: row.stage_id,
      stage: row.stage,
      startedAt: iso(row.started_at),
      finishedAt: iso(row.finished_at),
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      outcome: row.outcome,
    })),
    playback: playback.map((row) => ({
      segmentId: row.segment_id,
      responseEpoch: row.response_epoch === null ? null : Number(row.response_epoch),
      kind: row.speech_kind,
      generatedAt: iso(row.generated_at),
      sentAt: iso(row.sent_at),
      acknowledgedAt: iso(row.acknowledged_at),
      completedAt: iso(row.completed_at),
      terminalState: row.terminal_state,
      evidence: row.evidence,
    })),
    operations: operations.map((row) => ({
      operationId: row.operation_id,
      toolId: row.tool_id,
      state: row.state,
      startedAt: iso(row.started_at),
      settledAt: iso(row.settled_at),
    })),
  };
}
