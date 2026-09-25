import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export interface WorkerProviderQuota {
  provider: string;
  metric: string;
  limit: number | null;
  remaining: number | null;
  resetAt?: string;
}

export interface WorkerThrottle {
  provider: string;
  active: boolean;
  count: number;
  lastAt?: string;
}

export class WorkerInfrastructureMetrics {
  private readonly startedAt = new Date().toISOString();
  private readonly eventLoop = monitorEventLoopDelay({ resolution: 20 });
  private readonly quotas = new Map<string, WorkerProviderQuota>();
  private readonly throttles = new Map<string, WorkerThrottle>();
  private lastCpu = process.cpuUsage();
  private lastCpuAt = performance.now();

  constructor(
    private readonly options: {
      restartCount?: number;
      memoryLimitBytes?: number;
    } = {},
  ) {
    this.eventLoop.enable();
  }

  updateQuota(quota: WorkerProviderQuota) {
    validateText(quota.provider, 'provider');
    validateText(quota.metric, 'metric');
    this.quotas.set(`${quota.provider}:${quota.metric}`, Object.freeze({ ...quota }));
  }

  recordThrottle(provider: string, at = new Date()) {
    validateText(provider, 'provider');
    const current = this.throttles.get(provider);
    this.throttles.set(provider, {
      provider,
      active: true,
      count: (current?.count ?? 0) + 1,
      lastAt: at.toISOString(),
    });
  }

  clearThrottle(provider: string) {
    const current = this.throttles.get(provider);
    if (current) this.throttles.set(provider, { ...current, active: false });
  }

  snapshot() {
    const now = performance.now();
    const elapsedMicros = Math.max(1, (now - this.lastCpuAt) * 1_000);
    const usage = process.cpuUsage(this.lastCpu);
    this.lastCpu = process.cpuUsage();
    this.lastCpuAt = now;
    const cpuPercent = ((usage.user + usage.system) / elapsedMicros) * 100;
    const lagMs = Number.isFinite(this.eventLoop.mean) ? this.eventLoop.mean / 1_000_000 : null;
    this.eventLoop.reset();
    return {
      schemaVersion: 1,
      process: {
        startedAt: this.startedAt,
        restartCount: nonnegative(this.options.restartCount),
        cpuPercent: finite(cpuPercent),
        memoryRssBytes: process.memoryUsage().rss,
        memoryLimitBytes: nonnegative(this.options.memoryLimitBytes),
        eventLoopLagMs: finite(lagMs),
      },
      providerQuotas: [...this.quotas.values()],
      throttling: [...this.throttles.values()],
    };
  }

  close() {
    this.eventLoop.disable();
  }
}

function validateText(value: string, name: string) {
  if (!value.trim() || value.length > 100)
    throw new TypeError(`${name} must contain 1 to 100 characters`);
}
function finite(value: number | null) {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}
function nonnegative(value: number | undefined) {
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : null;
}
