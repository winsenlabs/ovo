import type { PoolClient } from 'pg';
import type { TelemetryEvent } from './telemetry-types.ts';

export async function updateCallProjection(
  client: PoolClient,
  event: TelemetryEvent,
): Promise<void> {
  const status =
    event.kind === 'session.ended'
      ? 'ended'
      : event.kind === 'session.failed'
        ? 'failed'
        : 'active';
  await client.query(
    `INSERT INTO ovo_telemetry_calls
       (workspace_id, call_id, source, agent_id, release_id, language, first_at, last_at,
        last_sequence, event_count, gap_detected, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,1,$8::bigint <> 0,$9)
     ON CONFLICT (workspace_id, call_id) DO UPDATE SET
       source=excluded.source,
       agent_id=COALESCE(ovo_telemetry_calls.agent_id, excluded.agent_id),
       release_id=COALESCE(ovo_telemetry_calls.release_id, excluded.release_id),
       language=COALESCE(ovo_telemetry_calls.language, excluded.language),
       first_at=LEAST(ovo_telemetry_calls.first_at, excluded.first_at),
       last_at=GREATEST(ovo_telemetry_calls.last_at, excluded.last_at),
       last_sequence=GREATEST(ovo_telemetry_calls.last_sequence, excluded.last_sequence),
       event_count=ovo_telemetry_calls.event_count + 1,
       status=CASE WHEN excluded.status='active' THEN ovo_telemetry_calls.status ELSE excluded.status END`,
    [
      event.workspaceId,
      event.callId,
      event.source,
      event.agentId ?? null,
      event.releaseId ?? null,
      event.language ?? null,
      event.occurredAt,
      event.sequence,
      status,
    ],
  );
  await client.query(
    `UPDATE ovo_telemetry_calls c SET gap_detected =
       c.event_count <> c.last_sequence + 1 OR NOT EXISTS (
         SELECT 1 FROM ovo_telemetry_events e
         WHERE e.workspace_id=c.workspace_id AND e.call_id=c.call_id AND e.sequence=0
       )
     WHERE c.workspace_id=$1 AND c.call_id=$2`,
    [event.workspaceId, event.callId],
  );
}

export async function updateStageProjection(client: PoolClient, event: TelemetryEvent) {
  if (!event.kind.startsWith('stage.') || !event.stageId || !event.stage) return;
  const terminal = event.kind !== 'stage.started';
  const outcome =
    event.kind === 'stage.started' ? 'running' : (event.outcome ?? stageOutcome(event.kind));
  await client.query(
    `INSERT INTO ovo_telemetry_stages
       (workspace_id,call_id,stage_id,stage,source,agent_id,release_id,provider,model,language,
        started_at,finished_at,duration_ms,outcome,updated_sequence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (workspace_id,call_id,stage_id) DO UPDATE SET
       stage=excluded.stage,
       provider=COALESCE(excluded.provider,ovo_telemetry_stages.provider),
       model=COALESCE(excluded.model,ovo_telemetry_stages.model),
       started_at=COALESCE(ovo_telemetry_stages.started_at,excluded.started_at),
       finished_at=COALESCE(ovo_telemetry_stages.finished_at,excluded.finished_at),
       duration_ms=COALESCE(ovo_telemetry_stages.duration_ms,excluded.duration_ms),
       outcome=CASE WHEN excluded.updated_sequence > ovo_telemetry_stages.updated_sequence
         THEN excluded.outcome ELSE ovo_telemetry_stages.outcome END,
       updated_sequence=GREATEST(ovo_telemetry_stages.updated_sequence,excluded.updated_sequence)`,
    [
      event.workspaceId,
      event.callId,
      event.stageId,
      event.stage,
      event.source,
      event.agentId ?? null,
      event.releaseId ?? null,
      event.provider ?? null,
      event.model ?? null,
      event.language ?? null,
      terminal ? null : event.occurredAt,
      terminal ? event.occurredAt : null,
      event.durationMs ?? null,
      outcome,
      event.sequence,
    ],
  );
  await client.query(
    `UPDATE ovo_telemetry_stages SET duration_ms=
       EXTRACT(EPOCH FROM (finished_at-started_at))*1000
     WHERE workspace_id=$1 AND call_id=$2 AND stage_id=$3
       AND duration_ms IS NULL AND started_at IS NOT NULL AND finished_at IS NOT NULL`,
    [event.workspaceId, event.callId, event.stageId],
  );
}

export async function updatePlaybackProjection(client: PoolClient, event: TelemetryEvent) {
  if (!event.kind.startsWith('playback.') || !event.segmentId) return;
  const phase = event.kind.slice('playback.'.length);
  const terminal = ['completed', 'interrupted', 'dropped', 'failed'].includes(phase);
  const timestamps = ['generated', 'queued', 'started', 'sent', 'acknowledged', 'completed'].map(
    (name) => (phase === name ? event.occurredAt : null),
  );
  await client.query(
    `INSERT INTO ovo_telemetry_playback
       (workspace_id,call_id,segment_id,response_epoch,speech_kind,generated_at,queued_at,
        started_at,sent_at,acknowledged_at,completed_at,terminal_state,evidence,updated_sequence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (workspace_id,call_id,segment_id) DO UPDATE SET
       response_epoch=COALESCE(ovo_telemetry_playback.response_epoch,excluded.response_epoch),
       speech_kind=COALESCE(ovo_telemetry_playback.speech_kind,excluded.speech_kind),
       generated_at=COALESCE(ovo_telemetry_playback.generated_at,excluded.generated_at),
       queued_at=COALESCE(ovo_telemetry_playback.queued_at,excluded.queued_at),
       started_at=COALESCE(ovo_telemetry_playback.started_at,excluded.started_at),
       sent_at=COALESCE(ovo_telemetry_playback.sent_at,excluded.sent_at),
       acknowledged_at=COALESCE(ovo_telemetry_playback.acknowledged_at,excluded.acknowledged_at),
       completed_at=COALESCE(ovo_telemetry_playback.completed_at,excluded.completed_at),
       terminal_state=CASE WHEN excluded.updated_sequence > ovo_telemetry_playback.updated_sequence
         THEN COALESCE(excluded.terminal_state,ovo_telemetry_playback.terminal_state)
         ELSE ovo_telemetry_playback.terminal_state END,
       evidence=CASE WHEN excluded.updated_sequence > ovo_telemetry_playback.updated_sequence
         THEN COALESCE(excluded.evidence,ovo_telemetry_playback.evidence)
         ELSE ovo_telemetry_playback.evidence END,
       updated_sequence=GREATEST(ovo_telemetry_playback.updated_sequence,excluded.updated_sequence)`,
    [
      event.workspaceId,
      event.callId,
      event.segmentId,
      event.responseEpoch ?? null,
      typeof event.payload?.speechKind === 'string' ? event.payload.speechKind : null,
      ...timestamps,
      terminal ? phase : null,
      event.evidence ?? null,
      event.sequence,
    ],
  );
}

export async function updateOperationProjection(client: PoolClient, event: TelemetryEvent) {
  if (!event.kind.startsWith('operation.') || !event.operationId) return;
  const state = event.kind.slice('operation.'.length);
  const terminal = !['intent', 'running'].includes(state);
  await client.query(
    `INSERT INTO ovo_telemetry_operations
       (workspace_id,call_id,operation_id,tool_id,state,started_at,settled_at,updated_sequence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (workspace_id,call_id,operation_id) DO UPDATE SET
       tool_id=COALESCE(ovo_telemetry_operations.tool_id,excluded.tool_id),
       state=CASE WHEN excluded.updated_sequence > ovo_telemetry_operations.updated_sequence
         THEN excluded.state ELSE ovo_telemetry_operations.state END,
       started_at=COALESCE(ovo_telemetry_operations.started_at,excluded.started_at),
       settled_at=CASE WHEN excluded.updated_sequence > ovo_telemetry_operations.updated_sequence
         THEN COALESCE(excluded.settled_at,ovo_telemetry_operations.settled_at)
         ELSE ovo_telemetry_operations.settled_at END,
       updated_sequence=GREATEST(ovo_telemetry_operations.updated_sequence,excluded.updated_sequence)`,
    [
      event.workspaceId,
      event.callId,
      event.operationId,
      typeof event.payload?.toolId === 'string' ? event.payload.toolId : null,
      state,
      terminal ? null : event.occurredAt,
      terminal ? event.occurredAt : null,
      event.sequence,
    ],
  );
}

function stageOutcome(kind: TelemetryEvent['kind']) {
  if (kind === 'stage.completed') return 'succeeded';
  if (kind === 'stage.timeout') return 'timeout';
  return 'failed';
}
