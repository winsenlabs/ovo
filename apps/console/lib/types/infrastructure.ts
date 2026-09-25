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
