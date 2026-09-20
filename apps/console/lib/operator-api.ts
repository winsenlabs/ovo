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
  variables: Record<string, string>;
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface EvaluationDataset {
  id: string;
  name: string;
  description: string;
  currentVersion: number;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}
export interface EvaluationCase {
  id: string;
  mode: 'announcement' | 'faq' | 'context' | 'agent';
  title: string;
  tags: string[];
  turns: Array<{ input: string; variables?: Record<string, unknown> }>;
  expected: Record<string, unknown>;
  fixture: Record<string, unknown>;
}
export interface EvaluationDatasetVersion {
  datasetId: string;
  version: number;
  fingerprint: string;
  cases: EvaluationCase[];
  createdAt: string;
  createdBy: string;
}
export interface ProviderEvaluationAuthorization {
  id: string;
  workspaceId: string;
  releaseId: string;
  releaseFingerprint: string;
  bindingVersion: string;
  provider: string;
  modelId: string;
  budgetId: string;
  maximumReservationPaise: string;
  createdBy: string;
  createdAt: string;
  revokedBy?: string;
  revokedAt?: string;
}
export interface EvaluationRunRecord {
  id: string;
  datasetId: string;
  datasetVersion: number;
  datasetFingerprint: string;
  releaseId: string;
  releaseFingerprint: string;
  fixtureBindingVersion: string;
  executorKind: 'fixture' | 'provider';
  budgetAuthorizationId?: string;
  status: 'queued' | 'running' | 'cancelling' | 'cancelled' | 'succeeded' | 'failed';
  attempt: number;
  maxAttempts: number;
  passed: number;
  failed: number;
  total: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
export interface EvaluationCaseResult {
  runId: string;
  caseId: string;
  mode: EvaluationCase['mode'];
  passed: boolean;
  outputs: string[];
  error?: string;
  operations: Array<{ toolId: string; state: string; confirmed: boolean }>;
  durationMs: number;
  createdAt: string;
}
export interface EvaluationComparison {
  baselineRunId: string;
  candidateRunId: string;
  baseline: { passed: number; failed: number; total: number };
  candidate: { passed: number; failed: number; total: number };
  regressions: string[];
  fixes: string[];
  unchangedFailures: string[];
}

export interface PriceCardVersion {
  id: string;
  version: string;
  provider: string;
  unit: string;
  currency: string;
  minorUnitsPerBlock: string;
  blockQuantity: string;
  effectiveAt: string;
  provenance: string;
}
export interface FxVersion {
  id: string;
  version: string;
  baseCurrency: string;
  quoteCurrency: 'INR';
  rateNumerator: string;
  rateDenominator: string;
  effectiveAt: string;
  provenance: string;
}
export interface ReconciliationResult {
  usageId: string;
  correctionId: string;
  deltaPaise: string;
  effectiveAmountPaise: string;
  state: 'reconciled';
}

export interface InfrastructureSnapshot {
  organizationId: string;
  generatedAt: string;
  filter: { releaseId: string | null };
  installation: {
    enabled: boolean;
    status: 'disabled' | 'ready' | 'degraded';
    reasons: string[];
    admissionSafety: string;
  };
  workers: {
    ready: number | null;
    busy: number | null;
    reserved: number | null;
    active: number | null;
    starting: number | null;
    draining: number | null;
    total: number | null;
    capacityCeiling: number | null;
    freshestHeartbeatAt: string | null;
    heartbeatMaxAgeMs: number;
    sampledWorkers: number | null;
    samplesTruncated: boolean | null;
  };
  queue: {
    depth: number | null;
    eligibleDepth: number | null;
    oldestAgeMs: number | null;
    reconciliationDepth: number | null;
    unresolvedCapacityWrites: number | null;
  };
  providers: {
    quotas: Array<{
      provider: string;
      metric: string;
      limit: number | null;
      remaining: number | null;
      resetAt: string | null;
      observedAt: string;
    }> | null;
    throttling: Array<{
      provider: string;
      active: boolean;
      count: number;
      lastAt: string | null;
    }> | null;
  };
  process: {
    cpuPercentAverage: number | null;
    memoryRssBytesTotal: number | null;
    memoryLimitBytesTotal: number | null;
    eventLoopLagMsMax: number | null;
    restartsTotal: number | null;
  };
  recordings: {
    queuedExports: number;
    runningExports: number;
    pendingDeletion: number;
    failedDeletion: number;
    finalizingArtifacts: number;
    failedArtifacts: number;
  } | null;
  telemetry: {
    eventsLastFiveMinutes: number;
    activeCalls: number;
    newestEventAt: string | null;
  } | null;
}
