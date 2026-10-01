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
}
