export const TELEMETRY_SCHEMA_VERSION = 1 as const;

export type TelemetrySource = 'live' | 'simulation';
export type TelemetryOutcome = 'running' | 'succeeded' | 'failed' | 'timeout' | 'unknown';

export type TelemetryEventKind =
  | 'session.started'
  | 'session.ended'
  | 'session.failed'
  | 'stage.started'
  | 'stage.completed'
  | 'stage.failed'
  | 'stage.timeout'
  | 'transcript.revision'
  | 'transcript.accepted'
  | 'playback.generated'
  | 'playback.queued'
  | 'playback.started'
  | 'playback.sent'
  | 'playback.acknowledged'
  | 'playback.completed'
  | 'playback.interrupted'
  | 'playback.dropped'
  | 'playback.failed'
  | 'operation.intent'
  | 'operation.running'
  | 'operation.succeeded'
  | 'operation.failed'
  | 'operation.unknown'
  | 'provider.usage';

export interface TelemetryEvent {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  eventId: string;
  workspaceId: string;
  callId: string;
  sequence: number;
  occurredAt: string;
  source: TelemetrySource;
  kind: TelemetryEventKind;
  agentId?: string;
  releaseId?: string;
  provider?: string;
  model?: string;
  language?: string;
  turnId?: string;
  responseEpoch?: number;
  stageId?: string;
  stage?: string;
  operationId?: string;
  segmentId?: string;
  durationMs?: number;
  outcome?: TelemetryOutcome;
  evidence?: 'generated' | 'simulated' | 'estimated' | 'confirmed';
  payload?: Record<string, unknown>;
}

export interface TelemetryIngestResult {
  inserted: number;
  duplicates: number;
  conflicts: number;
}

export interface TelemetryIngestionStats extends TelemetryIngestResult {
  accepted: number;
  dropped: number;
  failedBatches: number;
  failedEvents: number;
  queued: number;
  closed: boolean;
}

export interface PersistedTelemetryEvent extends TelemetryEvent {
  ingestedAt: string;
}

export interface TelemetryStreamPage {
  events: PersistedTelemetryEvent[];
  nextCursor: number;
  gap: null | { expected: number; actual: number };
}

export const PERFORMANCE_GROUPS = [
  'agent',
  'release',
  'provider',
  'model',
  'language',
  'stage',
  'source',
  'time',
] as const;
export type PerformanceGroup = (typeof PERFORMANCE_GROUPS)[number];

export interface PerformanceQuery {
  from: string;
  to: string;
  bucket: 'hour' | 'day';
  groupBy?: readonly PerformanceGroup[];
  agentId?: string;
  releaseId?: string;
  provider?: string;
  model?: string;
  language?: string;
  stage?: string;
  source?: TelemetrySource;
  maxGroups?: number;
  callLimit?: number;
}

export interface PerformanceGroupResult {
  cohort: Partial<Record<PerformanceGroup, string | null>>;
  eventCount: number;
  sampleCount: number;
  callCount: number;
  errors: number;
  timeouts: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  callIds: string[];
}

export interface PerformanceResult {
  from: string;
  to: string;
  bucket: 'hour' | 'day';
  groups: PerformanceGroupResult[];
  truncated: boolean;
}

export interface StageProjection {
  stageId: string;
  stage: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  outcome: TelemetryOutcome;
}

export interface PlaybackProjection {
  segmentId: string;
  responseEpoch: number | null;
  kind: string | null;
  generatedAt: string | null;
  sentAt: string | null;
  acknowledgedAt: string | null;
  completedAt: string | null;
  terminalState: string | null;
  evidence: string | null;
}

export interface OperationProjection {
  operationId: string;
  toolId: string | null;
  state: string;
  startedAt: string | null;
  settledAt: string | null;
}

export interface CallTelemetryProjection {
  callId: string;
  source: TelemetrySource;
  lastSequence: number;
  eventCount: number;
  gapDetected: boolean;
  status: string;
  stages: StageProjection[];
  playback: PlaybackProjection[];
  operations: OperationProjection[];
}

export interface TelemetryRepository {
  ingest(events: readonly TelemetryEvent[]): Promise<TelemetryIngestResult>;
  listCallEvents(
    workspaceId: string,
    callId: string,
    afterSequence: number,
    limit?: number,
  ): Promise<TelemetryStreamPage>;
  getCallProjection(
    workspaceId: string,
    callId: string,
    limit?: number,
  ): Promise<CallTelemetryProjection | undefined>;
  queryPerformance(workspaceId: string, query: PerformanceQuery): Promise<PerformanceResult>;
  prune(before: string, limit?: number): Promise<number>;
}

export interface PerformanceService {
  queryPerformance(workspaceId: string, query: PerformanceQuery): Promise<PerformanceResult>;
  listCallEvents(
    workspaceId: string,
    callId: string,
    afterSequence: number,
    limit?: number,
  ): Promise<TelemetryStreamPage>;
  ingestionStats?(): TelemetryIngestionStats;
}
