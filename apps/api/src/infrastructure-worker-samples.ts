import type {
  InfrastructureSnapshot,
  ProviderQuotaSnapshot,
  ProviderThrottleSnapshot,
} from './infrastructure-types.ts';

export interface WorkerSample {
  metadata: unknown;
  observed_at: Date;
}

interface WorkerMetrics {
  process: InfrastructureSnapshot['process'];
  quotas: ProviderQuotaSnapshot[] | null;
  throttling: ProviderThrottleSnapshot[] | null;
}

export function aggregateWorkerMetrics(samples: WorkerSample[]): WorkerMetrics {
  const cpu: number[] = [];
  const rss: number[] = [];
  const limits: number[] = [];
  const lag: number[] = [];
  const restarts: number[] = [];
  const quotas = new Map<string, ProviderQuotaSnapshot>();
  const throttles = new Map<string, ProviderThrottleSnapshot>();
  for (const sample of samples) {
    const infrastructure = record(record(sample.metadata)?.infrastructure);
    const process = record(infrastructure?.process);
    collect(process?.cpuPercent, cpu);
    collect(process?.memoryRssBytes, rss);
    collect(process?.memoryLimitBytes, limits);
    collect(process?.eventLoopLagMs, lag);
    collect(process?.restartCount, restarts);
    for (const value of array(infrastructure?.providerQuotas)) {
      const row = quota(value, sample.observed_at);
      if (row && !quotas.has(`${row.provider}:${row.metric}`))
        quotas.set(`${row.provider}:${row.metric}`, row);
    }
    for (const value of array(infrastructure?.throttling)) {
      const row = throttle(value);
      if (!row) continue;
      const current = throttles.get(row.provider);
      throttles.set(row.provider, current ? mergeThrottle(current, row) : row);
    }
  }
  return {
    process: {
      cpuPercentAverage: average(cpu),
      memoryRssBytesTotal: sumOrNull(rss),
      memoryLimitBytesTotal: sumOrNull(limits),
      eventLoopLagMsMax: lag.length ? Math.max(...lag) : null,
      restartsTotal: sumOrNull(restarts),
    },
    quotas: quotas.size ? [...quotas.values()] : null,
    throttling: throttles.size ? [...throttles.values()] : null,
  };
}

function quota(value: unknown, observedAt: Date): ProviderQuotaSnapshot | undefined {
  const row = record(value);
  if (!row || typeof row.provider !== 'string' || typeof row.metric !== 'string') return undefined;
  return {
    provider: row.provider.slice(0, 100),
    metric: row.metric.slice(0, 100),
    limit: nullableNumber(row.limit),
    remaining: nullableNumber(row.remaining),
    resetAt: typeof row.resetAt === 'string' ? row.resetAt : null,
    observedAt: observedAt.toISOString(),
  };
}

function throttle(value: unknown): ProviderThrottleSnapshot | undefined {
  const row = record(value);
  if (!row || typeof row.provider !== 'string' || typeof row.active !== 'boolean') return undefined;
  return {
    provider: row.provider.slice(0, 100),
    active: row.active,
    count: nullableNumber(row.count) ?? 0,
    lastAt: typeof row.lastAt === 'string' ? row.lastAt : null,
  };
}

function mergeThrottle(left: ProviderThrottleSnapshot, right: ProviderThrottleSnapshot) {
  return {
    provider: left.provider,
    active: left.active || right.active,
    count: left.count + right.count,
    lastAt:
      [left.lastAt, right.lastAt]
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, 100) : [];
}
function nullableNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function collect(value: unknown, target: number[]) {
  const parsed = nullableNumber(value);
  if (parsed !== null) target.push(parsed);
}
function average(values: number[]) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}
function sumOrNull(values: number[]) {
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}
