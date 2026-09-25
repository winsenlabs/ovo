export interface PerformanceGroupResult {
  cohort: Partial<
    Record<
      'agent' | 'release' | 'provider' | 'model' | 'language' | 'stage' | 'source' | 'time',
      string | null
    >
  >;
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
  ingestion: null | {
    accepted: number;
    dropped: number;
    failedEvents: number;
    queued: number;
    closed: boolean;
  };
}
export interface TelemetryEvent {
  eventId: string;
  callId: string;
  sequence: number;
  occurredAt: string;
  source: 'live' | 'simulation';
  kind: string;
  stage?: string;
  provider?: string;
  model?: string;
  durationMs?: number;
  outcome?: string;
  evidence?: string;
  ingestedAt: string;
}
export interface BudgetSnapshot {
  id: string;
  workspaceId: string;
  limitPaise: string;
  admissionOverspendPaise: string;
  spentPaise: string;
  reservedPaise: string;
  availableForAdmissionPaise: string;
  overLimit: boolean;
}
export interface ScenarioResult {
  targetRevenuePaise: string;
  durationSeconds: string;
  totalCostPaise: string;
  marginPaise: string;
  withinTarget: boolean;
  marginScope: string;
  components: Array<{
    id: string;
    category: string;
    amountPaise: string;
    currency: string;
    assumption: string;
  }>;
}
export interface CallCostSummary {
  sessionId: string;
  currency: 'INR';
  estimatedPaise: string;
  reconciledPaise: string;
  totalPaise: string;
}
export interface CampaignRecord {
  id: string;
  operationId: string;
  name: string;
  agentReleaseId: string;
  fromNumber: string;
  status: 'scheduled' | 'running' | 'paused' | 'cancelled' | 'completed';
  scheduleAt: string;
  timezone: string;
  version: number;
  perNumberAttemptLimit: number;
  maxAttemptsTotal: number;
  maxAttemptsPerLocalDay: number;
  maxConcurrency?: number;
  attempts?: { id: string; status: string }[];
  activeCallPolicy: 'continue' | 'request_end';
}
export interface CampaignPreview {
  headers: string[];
  rows: Array<{
    sourceRow: number;
    phoneNumber: string;
    externalId?: string;
    variables: Record<string, string>;
  }>;
  errors: Array<{ row: number; field: string; message: string }>;
  truncated: boolean;
  exportSafe: true;
}
export interface SuppressionRecord {
  phoneNumber: string;
  reason: string;
  createdAt: string;
}
export interface HandoffRecord {
  id: string;
  operationId: string;
  callId: string;
  target: { kind: 'phone' | 'queue'; value: string };
  fallback: { kind: 'resume' | 'end' | 'human'; message: string; target?: string };
  status: string;
  attempt: number;
  fallbackAttempt: number;
  retryable: boolean;
  providerReceiptId?: string;
  lastError?: string;
}
export interface InboundRouteRecord {
  organizationId: string;
  phoneNumber: string;
  releaseId: string;
  carrierPluginId?: string | null;
  carrierBindingId?: string | null;
  variables: Record<string, string>;
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}
